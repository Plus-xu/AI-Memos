/* global DraftStorage, MemosAPI */
/* exported MemoIndex */
/**
 * What the tag button and random review need from the server, kept per account in session storage: the
 * tags, and the names of the memos. Each is used for ten minutes; after that the old value is still
 * returned while a new one is loaded.
 */
var MemoIndex = (function () {
  const TTL = 10 * 60e3,
    FRESH = 5e3,
    LIMIT = 20000,
    RECENT = 5 * 60e3;
  const loading = new Map();
  // Holds an account's index for this page when session storage cannot.
  const memory = new Map();

  const keyOf = info => 'memosIndex:' + DraftStorage.scope(info);
  const strings = list => (Array.isArray(list) && list.every(item => typeof item === 'string') ? list : null);
  const sorted = tags => Array.from(new Set(tags)).sort();

  function entryOf(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      tags: strings(raw.tags),
      tagsAt: Number(raw.tagsAt) || 0,
      // True when the tags come from listing the memos, because the server has no statistics.
      scanned: raw.scanned === true,
      names: strings(raw.names),
      namesAt: Number(raw.namesAt) || 0,
      // The tags of the listed memos: the tags of a server without statistics.
      listed: strings(raw.listed),
      listedAt: Number(raw.listedAt) || 0,
      // Counts the changes below. A load notes the count when it begins, in place of a clock: two pages
      // can change the index within the same millisecond.
      seq: Number(raw.seq) || 0,
      // Saves and archives of the last minutes; a load that began before one applies it again.
      recent: Array.isArray(raw.recent)
        ? raw.recent.filter(change => change && typeof change.at === 'number' && typeof change.seq === 'number')
        : []
    };
  }

  async function read(key) {
    if (memory.has(key)) return entryOf(memory.get(key));
    try {
      return entryOf((await DraftStorage.get('session', { [key]: null }))[key]);
    } catch (_) {
      return entryOf(null);
    }
  }

  async function write(key, entry) {
    try {
      await DraftStorage.put('session', { [key]: entry });
      memory.delete(key);
    } catch (_) {
      memory.set(key, entry);
    }
  }

  // The popup and the side panel share the index, so every change is made under one lock.
  function update(key, change) {
    return DraftStorage.locked('memos-index', async () => {
      const entry = await read(key);
      change(entry);
      await write(key, entry);
      return entry;
    });
  }

  function apply(entry, change) {
    if (entry.names && change.remove) entry.names = entry.names.filter(name => name !== change.remove);
    if (entry.names && change.add && !entry.names.includes(change.add))
      entry.names = [change.add].concat(entry.names).slice(0, LIMIT);
    if (entry.tags && change.tags) entry.tags = sorted(entry.tags.concat(change.tags));
    if (entry.listed && change.tags) entry.listed = sorted(entry.listed.concat(change.tags));
    // A tag may have lost its last memo, which only the server can tell: both lists are due for a check.
    if (change.stale) entry.tagsAt = entry.listedAt = 0;
    // What another access token was shown is not this one's to keep.
    if (change.reset) entry.tags = entry.names = entry.listed = null;
  }

  // The count of changes so far: what a load notes before it asks the server.
  async function mark(key) {
    return (await read(key)).seq;
  }

  // Stores what a load found, then repeats the changes made since the load began.
  function land(key, since, found) {
    return update(key, entry => {
      found(entry);
      for (const change of entry.recent) if (change.seq > since) apply(entry, change);
    });
  }

  function once(id, work) {
    if (!loading.has(id))
      loading.set(
        id,
        work().finally(() => loading.delete(id))
      );
    return loading.get(id);
  }

  function scan(info) {
    const key = keyOf(info);
    return once('names ' + key, async () => {
      const since = await mark(key);
      // Older servers may list archived memos too; those are neither reviewed nor tagged.
      const memos = (await MemosAPI.listMemos(info)).filter(
        memo => memo.state !== 'ARCHIVED' && memo.rowStatus !== 'ARCHIVED'
      );
      const entry = await land(key, since, entry => {
        entry.names = memos
          .map(memo => memo.name)
          .filter(name => typeof name === 'string' && /^memos\/[^/]+$/.test(name))
          .slice(0, LIMIT);
        entry.namesAt = Date.now();
        entry.listed = sorted(memos.flatMap(memo => strings(memo.tags) || []));
        entry.listedAt = entry.namesAt;
        if (entry.scanned) {
          entry.tags = entry.listed;
          entry.tagsAt = entry.namesAt;
        }
      });
      return { names: entry.names, listed: entry.listed, since };
    });
  }

  function loadTags(info) {
    const key = keyOf(info);
    return once('tags ' + key, async () => {
      let since = await mark(key);
      const counted = await MemosAPI.userTags(info);
      let listed = [];
      if (!counted) {
        // One listing serves both the names and the tags, whichever asked for it.
        const known = await read(key);
        if (known.listed && Date.now() - known.listedAt < TTL) listed = known.listed;
        else {
          // A listing already on its way began earlier, so the changes since then count again.
          const listing = await scan(info);
          listed = listing.listed || [];
          since = Math.min(since, listing.since);
        }
      }
      const entry = await land(key, since, entry => {
        // The index's own list has every tag saved since its listing began.
        entry.tags = counted ? sorted(counted) : entry.listed || listed;
        entry.tagsAt = Date.now();
        entry.scanned = !counted;
      });
      return entry.tags || [];
    });
  }

  /** The account's tags, sorted. A stale list is returned at once; onRefresh gets the new one if it differs. */
  async function tags(info, onRefresh) {
    const entry = await read(keyOf(info));
    if (!entry.tags) return loadTags(info);
    if (Date.now() - entry.tagsAt >= TTL)
      loadTags(info).then(
        fresh => {
          if (onRefresh && fresh.join('\n') !== entry.tags.join('\n')) onRefresh(fresh);
        },
        () => {}
      );
    return entry.tags;
  }

  /** The names of the account's memos. With `fresh`, only a listing made in the last few seconds will do. */
  async function names(info, fresh) {
    const entry = await read(keyOf(info));
    const age = Date.now() - entry.namesAt;
    if (!entry.names || (fresh && age >= FRESH)) return (await scan(info)).names || [];
    if (age >= TTL) scan(info).catch(() => {});
    return entry.names;
  }

  // The index only saves requests: a change that cannot be recorded must never fail a save or an archive.
  function record(info, change) {
    const at = Date.now();
    return update(keyOf(info), entry => {
      apply(entry, change);
      entry.seq++;
      entry.recent = entry.recent.filter(old => at - old.at < RECENT).concat({ ...change, at, seq: entry.seq });
    }).then(
      () => {},
      () => {}
    );
  }

  function saved(info, memo) {
    const memoTags = strings(memo.tags);
    return record(info, memoTags ? { add: memo.name, tags: memoTags } : { add: memo.name, stale: true });
  }

  return {
    tags,
    names,
    saved,
    clear: info => record(info, { reset: true }),
    archived: (info, name) => record(info, { remove: name, stale: true }),
    restored: (info, name) => record(info, { add: name, stale: true }),
    forget: (info, name) => record(info, { remove: name })
  };
})();
