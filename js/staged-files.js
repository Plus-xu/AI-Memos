/* global DraftStorage, MemosAPI */
/* exported StagedFiles */
/** Draft attachment bytes stay in IndexedDB until the user saves the memo. */
var StagedFiles = (function () {
  const prefix = 'memos-local://';
  // A file goes up as base64 inside one JSON request, so it is refused here before it can fail there.
  const DEFAULT_LIMIT = 30 * 1024 * 1024;
  let database;

  function open() {
    if (!database)
      database = new Promise((resolve, reject) => {
        const request = indexedDB.open('ai-memos-files', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(error => {
        database = null;
        throw error;
      });
    return database;
  }

  async function access(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const request = work(tx.objectStore('files'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('fileStorageFailed'));
    });
  }

  async function stage(blob, filename, label, reuse = false, limit) {
    if (limit !== undefined && blob.size > limit) throw new Error('fileTooLarge');
    const name = (filename || 'attachment').replace(/[\r\n]/g, ' ');
    let id = crypto.randomUUID();
    if (reuse) {
      // Distinguish changed images at the same source URL while allowing repeated clips to share one upload.
      const bytes = new Blob([JSON.stringify([name, blob.type]), '\n', blob]);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer()));
      const hex = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
      id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    }
    await DraftStorage.locked('memos-file-' + id, async () => {
      const entry = reuse && (await access('readonly', store => store.get(id)));
      await access('readwrite', store =>
        store.put({ id, blob, name, uploads: entry?.uploads || {}, created: Date.now() })
      );
    });
    const alt = (label || name).replace(/[\r\n]/g, ' ');
    return (
      (blob.type.startsWith('image/') ? '!' : '') + '[' + alt.replace(/[\\[\]]/g, '\\$&') + '](' + prefix + id + ')'
    );
  }

  function limits(stored) {
    return stored && typeof stored === 'object' ? stored : {};
  }

  /** The largest file to stage for the connected account, in bytes. Never asks the server. */
  async function limit() {
    try {
      const sync = await DraftStorage.get('sync', { apiUrl: '', userName: '', userid: '' });
      const account = DraftStorage.scope({
        ...sync,
        apiUrl: String(sync.apiUrl).trim().replace(/\/+$/, '') + '/'
      });
      const known = limits((await DraftStorage.get('local', { memosUploadLimits: {} })).memosUploadLimits)[account];
      return Number.isSafeInteger(known?.bytes) && known.bytes > 0 ? known.bytes : DEFAULT_LIMIT;
    } catch (_) {
      return DEFAULT_LIMIT;
    }
  }

  /** Asks the server for the account's limit when the remembered one is a day old, or on `force`. For pages only. */
  async function refreshLimit(info, force) {
    try {
      const account = DraftStorage.scope(info);
      const read = async () => limits((await DraftStorage.get('local', { memosUploadLimits: {} })).memosUploadLimits);
      const known = (await read())[account];
      if (!force && known && Date.now() - known.at < 86400000) return;
      // A server that does not say is remembered too, so it is not asked on every opening.
      const bytes = (await MemosAPI.uploadLimit(info)) || DEFAULT_LIMIT;
      await DraftStorage.locked('memos-upload-limits', async () => {
        const all = await read();
        all[account] = { bytes, at: Date.now() };
        await DraftStorage.put('local', { memosUploadLimits: all });
      });
    } catch (_) {
      /* The default limit applies until a later opening succeeds. */
    }
  }

  function base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function ids(content) {
    return Array.from(new Set(Array.from(content.matchAll(/memos-local:\/\/([a-f0-9-]{36})/gi), hit => hit[1])));
  }

  async function resolve(info, content, attemptId, checkDestination) {
    const refs = ids(content);
    if (!refs.length) return content;
    const account = DraftStorage.scope(info);
    for (const id of refs) {
      const url = await DraftStorage.locked('memos-file-' + id, async () => {
        const entry = await access('readonly', store => store.get(id));
        if (!entry) throw new Error('stagedFileMissing');
        const cached = entry.uploads[account];
        if (cached?.attemptId === attemptId && cached.url) return cached.url;
        const bytes = await base64(entry.blob);
        checkDestination?.(info);
        const file = await MemosAPI.uploadAttachment(info, {
          filename: entry.name,
          type: entry.blob.type || 'application/octet-stream',
          content: bytes
        });
        const uploaded = MemosAPI.buildFileUrl(info.apiUrl, file);
        if (!file.name || !MemosAPI.managedFile(info.apiUrl, uploaded)) throw new Error('stagedFileMissing');
        entry.uploads[account] = { attemptId, url: uploaded };
        await access('readwrite', store => store.put(entry));
        return uploaded;
      });
      content = content.replaceAll(prefix + id, url);
    }
    return content;
  }

  // Keep files used by current drafts and AI undo, including across a failed save.
  async function collect() {
    const draft = await DraftStorage.current();
    const review = await DraftStorage.get('local', {
      memosAIReview: null,
      memosAIUndo: null,
      'memosDraftConflict:popup': null,
      'memosDraftConflict:panel': null
    });
    const keep = new Set(ids(draft.open_content + JSON.stringify(review)));
    const cutoff = Date.now() - 7 * 86400000;
    await access('readwrite', store => {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        if (item.value.created < cutoff && !keep.has(item.key)) item.delete();
        item.continue();
      };
    });
  }

  /**
   * Stages a remote image. `budget` is `{ each, left }` in bytes: the image must fit both, and what it
   * takes is subtracted from `left`. An image that does not fit fails with 'imageTooLarge'.
   */
  async function fromUrl(raw, label, budget) {
    const url = new URL(raw);
    if (!['https:', 'http:', 'data:'].includes(url.protocol) || url.username || url.password)
      throw new Error('imageCaptureFailed');
    const response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error('imageCaptureFailed');
    const room = () => (budget ? Math.min(budget.each, budget.left) : Infinity);
    // A declared length saves the download; the bytes that arrive decide either way.
    if (Number(response.headers?.get('content-length')) > room()) {
      // An unread body would hold its connection until the timeout.
      try {
        Promise.resolve(response.body?.cancel()).catch(() => {});
      } catch (_) {
        /* nothing left to cancel */
      }
      throw new Error('imageTooLarge');
    }
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('imageCaptureFailed');
    if (blob.size > room()) throw new Error('imageTooLarge');
    if (budget) budget.left -= blob.size;
    let name = '';
    if (url.protocol !== 'data:') {
      try {
        name = decodeURIComponent(url.pathname.split('/').pop());
      } catch (_) {
        /* use a MIME-derived name */
      }
    }
    return stage(blob, name || 'image.' + blob.type.slice(6).split('+')[0], label, true);
  }

  return { DEFAULT_LIMIT, limit, refreshLimit, stage, fromUrl, resolve, collect, ids };
})();
