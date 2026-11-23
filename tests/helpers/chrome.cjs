/** A stand-in for chrome.* whose storage follows the real contract. */
const { plain } = require('./scripts.cjs');

function area(store, onSet) {
  return {
    // Like the real API, only the requested keys come back, as copies.
    get(keys, callback) {
      const stored = names =>
        Object.fromEntries(names.filter(key => Object.hasOwn(store, key)).map(key => [key, store[key]]));
      let result;
      if (keys === null || keys === undefined) result = store;
      else if (typeof keys === 'string') result = stored([keys]);
      else if (Array.isArray(keys)) result = stored(keys);
      else result = { ...keys, ...stored(Object.keys(keys)) };
      callback(plain(result));
    },
    set(values, callback) {
      onSet?.(values);
      Object.assign(store, plain(values));
      callback?.();
    },
    remove(keys, callback) {
      for (const key of [].concat(keys)) delete store[key];
      callback?.();
    }
  };
}

/**
 * sync and local are the backing objects, which tests read and write directly; pass the same object twice
 * for one merged store. onSyncSet sees every write to sync before it lands.
 */
function createChrome({ sync = {}, local = {}, messages = key => key, onSyncSet } = {}) {
  const listeners = [];
  return {
    runtime: { lastError: null },
    i18n: { getMessage: messages },
    storage: {
      local: area(local),
      sync: area(sync, onSyncSet),
      onChanged: {
        addListener: listener => listeners.push(listener),
        // Not in the real API. Writes here notify nobody; a test delivers a change by calling this.
        emit: (changes, areaName) => listeners.forEach(listener => listener(changes, areaName))
      }
    }
  };
}

module.exports = { createChrome };
