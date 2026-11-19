/** Draft attachment bytes stay in IndexedDB until the user saves the memo. */
var StagedFiles = (function () {
  const prefix = 'memos-local://';
  let database;

  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('ai-memos-files', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => { database = null; throw error; });
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

  async function stage(blob, filename, label, reuse = false) {
    const name = (filename || 'attachment').replace(/[\r\n]/g, ' ');
    let id = crypto.randomUUID();
    if (reuse) {
      // Distinguish changed images at the same source URL while allowing repeated clips to share one upload.
      const bytes = new Blob([JSON.stringify([name, blob.type]), '\n', blob]);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer()));
      const hex = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
      id = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    }
    await DraftStorage.locked('memos-file-' + id, async () => {
      const entry = reuse && await access('readonly', store => store.get(id));
      await access('readwrite', store => store.put({ id, blob, name, uploads: entry?.uploads || {}, created: Date.now() }));
    });
    const alt = (label || name).replace(/[\r\n]/g, ' ');
    return (blob.type.startsWith('image/') ? '!' : '') + '[' + alt.replace(/[\\[\]]/g, '\\$&') + '](' + prefix + id + ')';
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

  async function resolve(info, content, attemptId) {
    const refs = ids(content);
    if (!refs.length) return content;
    const account = DraftStorage.scope(info);
    for (const id of refs) {
      const url = await DraftStorage.locked('memos-file-' + id, async () => {
        const entry = await access('readonly', store => store.get(id));
        if (!entry) throw new Error('stagedFileMissing');
        const cached = entry.uploads[account];
        if (cached?.attemptId === attemptId && cached.url) return cached.url;
        const file = await MemosAPI.uploadAttachment(info, {
          filename: entry.name, type: entry.blob.type || 'application/octet-stream', content: await base64(entry.blob)
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
    const review = await DraftStorage.get('local', { memosAIReview: null, memosAIUndo: null, 'memosDraftConflict:popup': null, 'memosDraftConflict:panel': null });
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

  async function fromUrl(raw, label) {
    const url = new URL(raw);
    if (!['https:', 'http:', 'data:'].includes(url.protocol) || url.username || url.password) throw new Error('imageCaptureFailed');
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('imageCaptureFailed');
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('imageCaptureFailed');
    let name = '';
    if (url.protocol !== 'data:') {
      try { name = decodeURIComponent(url.pathname.split('/').pop()); } catch (_) { /* use a MIME-derived name */ }
    }
    return stage(blob, name || 'image.' + blob.type.slice(6).split('+')[0], label, true);
  }

  return { stage, fromUrl, resolve, collect, ids };
})();
