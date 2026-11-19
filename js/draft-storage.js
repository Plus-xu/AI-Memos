/** The popup, side panel and service worker share one origin and one draft lock. */
var DraftStorage = (function () {
  const queues = new Map();

  function locked(name, work) {
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(name, work);
    const next = (queues.get(name) || Promise.resolve()).then(work);
    queues.set(name, next.catch(() => {}));
    return next;
  }

  function get(area, defaults) {
    return new Promise((resolve, reject) => chrome.storage[area].get(defaults, items =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(items)));
  }

  function put(area, fields) {
    return new Promise((resolve, reject) => chrome.storage[area].set(fields, () =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
  }

  function normalize(raw) {
    return {
      open_action: raw.open_action || '', open_content: raw.open_content || '',
      revision: Number(raw.revision) || 0, sources: Array.isArray(raw.sources) ? raw.sources : []
    };
  }

  async function current() {
    const { memosDraft } = await get('local', { memosDraft: null });
    if (memosDraft && typeof memosDraft.open_content === 'string') return normalize(memosDraft);
    return normalize(await get('sync', { open_action: '', open_content: '' }));
  }

  function load(callback) {
    return current().then(callback);
  }

  function changeRange(base, value) {
    let start = 0;
    while (start < base.length && start < value.length && base[start] === value[start]) start++;
    let end = base.length, tail = value.length;
    while (end > start && tail > start && base[end - 1] === value[tail - 1]) { end--; tail--; }
    return { start, end, text: value.slice(start, tail) };
  }

  function merge(base, local, remote) {
    if (local === remote || local === base) return remote;
    if (remote === base) return local;
    const a = changeRange(base, local), b = changeRange(base, remote);
    if (a.start === b.start && a.start === a.end && b.start === b.end) return null;
    const [first, last] = a.start < b.start || (a.start === b.start && a.end < b.end) ? [a, b] : [b, a];
    if (first.end > last.start) return null;
    return base.slice(0, first.start) + first.text + base.slice(first.end, last.start) + last.text + base.slice(last.end);
  }

  async function storeDraft(old, value, sources, action) {
    const links = new Map();
    for (const source of sources) {
      if (source && source.url && value.includes(source.url)) links.set(source.url, source);
    }
    const draft = { open_action: action || (value ? 'save_text' : ''), open_content: value,
      revision: old.revision + 1, sources: Array.from(links.values()) };
    await put('local', { memosDraft: draft });
    return draft;
  }

  function commit(base, text, sources = []) {
    return locked('memos-draft', async () => {
      const latest = await current();
      const value = merge(base.open_content, text, latest.open_content);
      if (value === null) throw Object.assign(new Error('draftConflict'), { latest });
      if (value === latest.open_content && latest.revision > 0 && !sources.length) return latest;
      return storeDraft(latest, value, latest.sources.concat(sources));
    });
  }

  function append(text, callback, sources = []) {
    const pending = locked('memos-draft', async () => {
      const old = await current();
      return storeDraft(old, (old.open_content ? old.open_content.trimEnd() + '\n\n' : '') + text, old.sources.concat(sources));
    });
    if (callback) pending.then(draft => callback(null, draft.open_content), callback);
    return pending;
  }

  function finish(snapshot) {
    return locked('memos-draft', async () => {
      const latest = await current();
      const text = latest.open_content;
      if (text === snapshot.open_content) return storeDraft(latest, '', []);
      const prefix = snapshot.open_content.trimEnd() + '\n\n';
      if (text.startsWith(prefix)) return storeDraft(latest, text.slice(prefix.length), latest.sources);
      return latest;
    });
  }

  function scope(info) {
    return JSON.stringify([info.apiUrl, info.userName || info.userid || '']);
  }

  function record(info, memo, sources) {
    if (!sources.length) return Promise.resolve();
    return locked('memos-history', async () => {
      const { memosClipHistory } = await get('local', { memosClipHistory: {} });
      const account = scope(info), savedAt = new Date().toISOString();
      const previous = memosClipHistory[account] || [];
      const additions = sources.map(source => ({ url: source.url, title: source.title, memo: memo.name, savedAt }));
      memosClipHistory[account] = additions.concat(previous.filter(item => item.memo !== memo.name)).slice(0, 300);
      await put('local', { memosClipHistory });
    });
  }

  async function history(info) {
    const { memosClipHistory } = await get('local', { memosClipHistory: {} });
    return memosClipHistory[scope(info)] || [];
  }

  return { current, load, commit, append, finish, merge, get, put, locked, scope, record, history };
})();
