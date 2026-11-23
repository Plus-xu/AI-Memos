/** An in-memory indexedDB, as far as the extension uses one: key-path object stores, get, put and cursors. */

/**
 * Callbacks fire on later turns of the event loop, records are copied going in and coming out, and a
 * transaction completes once it has nothing left to do. `stores` maps '<database>/<store>' to the Map of
 * records behind that store; hand one in to seed or inspect it.
 */
function createIndexedDB(stores = new Map()) {
  const versions = new Map();
  const keyPaths = new Map();

  function transaction(database, name, mode) {
    const id = database + '/' + name;
    const missing = () => new DOMException('No such object store.', 'NotFoundError');
    if (!keyPaths.has(id)) throw missing();
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError('Unknown transaction mode: ' + mode);
    const records = stores.get(id);
    const keyPath = keyPaths.get(id);
    const tx = { error: null };
    const pending = [];
    let finished = false;
    let scheduled = false;

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        const next = pending.shift();
        if (next) {
          next();
          schedule();
        } else {
          finished = true;
          tx.oncomplete?.();
        }
      });
    }

    function check(writes) {
      if (finished) throw new DOMException('The transaction has finished.', 'TransactionInactiveError');
      if (writes && mode !== 'readwrite') throw new DOMException('The transaction is read-only.', 'ReadOnlyError');
    }

    function enqueue(work, request = {}) {
      pending.push(() => {
        request.result = work(request);
        request.onsuccess?.();
      });
      schedule();
      return request;
    }

    const store = {
      get(key) {
        check(false);
        return enqueue(() => structuredClone(records.get(key)));
      },
      put(value) {
        check(true);
        const copy = structuredClone(value);
        return enqueue(() => {
          records.set(copy[keyPath], copy);
          return copy[keyPath];
        });
      },
      openCursor() {
        check(false);
        let keys;
        let index = 0;
        const visit = request => {
          keys = keys || Array.from(records.keys()).sort();
          while (index < keys.length && !records.has(keys[index])) index++;
          if (index >= keys.length) return null;
          const key = keys[index];
          return {
            key,
            value: structuredClone(records.get(key)),
            delete() {
              check(true);
              return enqueue(() => void records.delete(key));
            },
            continue() {
              check(false);
              index++;
              enqueue(visit, request);
            }
          };
        };
        return enqueue(visit);
      }
    };
    tx.objectStore = requested => {
      if (requested !== name) throw missing();
      return store;
    };
    schedule();
    return tx;
  }

  function open(name, version = 1) {
    const request = {};
    setImmediate(() => {
      request.result = {
        createObjectStore(store, { keyPath }) {
          const id = name + '/' + store;
          keyPaths.set(id, keyPath);
          if (!stores.has(id)) stores.set(id, new Map());
        },
        transaction: (store, mode = 'readonly') => transaction(name, store, mode)
      };
      if ((versions.get(name) || 0) < version) {
        versions.set(name, version);
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    });
    return request;
  }

  return { open };
}

module.exports = { createIndexedDB };
