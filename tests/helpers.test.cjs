const test = require('node:test');
const assert = require('node:assert/strict');
const { createChrome } = require('./helpers/chrome.cjs');
const { createDom } = require('./helpers/dom.cjs');
const { createIndexedDB } = require('./helpers/indexeddb.cjs');

const read = (area, keys) => new Promise(resolve => area.get(keys, resolve));

test('storage stand-in: get returns only the requested keys, in each of the four key forms', async () => {
  const { storage } = createChrome({ sync: { a: 1, b: 2 } });
  assert.deepEqual(await read(storage.sync, 'a'), { a: 1 });
  assert.deepEqual(await read(storage.sync, ['a', 'missing']), { a: 1 });
  assert.deepEqual(await read(storage.sync, { a: 0, missing: 'default' }), { a: 1, missing: 'default' });
  assert.deepEqual(await read(storage.sync, null), { a: 1, b: 2 });
});

test('storage stand-in: values are copied on the way in and on the way out', async () => {
  const local = {};
  const { storage } = createChrome({ local });
  const written = { list: [1] };
  storage.local.set({ written });
  written.list.push(2);
  assert.deepEqual(local.written, { list: [1] });
  (await read(storage.local, 'written')).written.list.push(3);
  assert.deepEqual(local.written, { list: [1] });
});

test('storage stand-in: remove deletes one key or a list of keys', () => {
  const local = { a: 1, b: 2, c: 3, d: 4 };
  const { storage } = createChrome({ local });
  storage.local.remove('a');
  storage.local.remove(['b', 'c', 'missing']);
  assert.deepEqual(local, { d: 4 });
});

test('storage stand-in: one backing object for both areas is one merged store', async () => {
  const store = {};
  const { storage } = createChrome({ sync: store, local: store });
  storage.sync.set({ fromSync: 1 });
  assert.deepEqual(await read(storage.local, 'fromSync'), { fromSync: 1 });
});

test('storage stand-in: onSyncSet sees a write to sync before it lands, and never a write to local', () => {
  const sync = {},
    local = {};
  const refused = [];
  const { storage } = createChrome({
    sync,
    local,
    onSyncSet(values) {
      refused.push(values);
      throw new Error('refused');
    }
  });
  assert.throws(() => storage.sync.set({ a: 1 }), /refused/);
  storage.local.set({ b: 2 });
  assert.deepEqual([refused, sync, local], [[{ a: 1 }], {}, { b: 2 }]);
});

test('storage stand-in: change listeners hear nothing from a write, only what a test emits', () => {
  const { storage } = createChrome();
  const heard = [];
  storage.onChanged.addListener((changes, area) => heard.push([changes, area]));
  storage.local.set({ a: 1 });
  assert.deepEqual(heard, []);
  storage.onChanged.emit({ a: { newValue: 1 } }, 'local');
  assert.deepEqual(heard, [[{ a: { newValue: 1 } }, 'local']]);
});

test('page stand-in: every handler under a key runs, in order, and the last result is returned', () => {
  const { $, handlers } = createDom();
  const calls = [];
  $('#save').on('click', () => calls.push('first'));
  $('#save').click(() => {
    calls.push('second');
    return 'done';
  });
  assert.equal(handlers.get('#save:click')(), 'done');
  assert.deepEqual(calls, ['first', 'second']);
});

test('page stand-in: several event names register one key each, and a delegated selector is part of the key', () => {
  const { $, document, handlers } = createDom();
  $('#content').on('input change', () => {});
  $(document).on('click', '.item', () => {});
  assert.deepEqual(Array.from(handlers.keys()), ['#content:input', '#content:change', 'document:click:.item']);
});

test('page stand-in: a triggered handler gets the element as this and as the event target', () => {
  const { $, node } = createDom();
  const element = node('#task')[0];
  let seen;
  $('#task').change(function (event) {
    seen = { self: this, target: event.target, wrapped: $(this) };
  });
  $('#task').trigger('change');
  assert.equal(seen.self, element);
  assert.equal(seen.target, element);
  assert.equal(seen.wrapped, node('#task'));
});

test('page stand-in: listeners added to the document itself are fired by key', () => {
  const { document, handlers } = createDom();
  let ready = 0;
  document.addEventListener('DOMContentLoaded', () => ready++);
  document.addEventListener('DOMContentLoaded', () => ready++);
  handlers.get('document:DOMContentLoaded')();
  assert.equal(ready, 2);
});

test('page stand-in: an element listener is fired by the same key as a jQuery handler', () => {
  const { $, document, handlers } = createDom();
  const calls = [];
  $('#provider').on('change', () => calls.push('jquery'));
  document.getElementById('provider').addEventListener('change', () => calls.push('element'));
  handlers.get('#provider:change')();
  assert.deepEqual(calls, ['jquery', 'element']);
});

test('page stand-in: an element lists the options given to it, and replacing its children starts over', () => {
  const { document, Option } = createDom();
  const select = document.getElementById('space');
  assert.deepEqual(select.options, []);
  select.replaceChildren(new Option('None', ''));
  select.add(new Option('Reading', 'spaces/reading'));
  assert.deepEqual(
    select.options.map(option => [option.text, option.value]),
    [
      ['None', ''],
      ['Reading', 'spaces/reading']
    ]
  );
  const before = select.options;
  select.replaceChildren();
  assert.deepEqual(select.options, []);
  assert.notEqual(select.options, before, 'a redraw is visible as a new list');
});

/** Opens the stand-in the way a script would, creating one key-path store on first use. */
function openFiles(indexedDB, upgrades = []) {
  return new Promise(resolve => {
    const request = indexedDB.open('db', 1);
    request.onupgradeneeded = () => {
      upgrades.push(request.result);
      request.result.createObjectStore('files', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

/** Runs work in one transaction; resolves with its request's result once the transaction completes. */
function inFiles(db, mode, work) {
  return new Promise(resolve => {
    const tx = db.transaction('files', mode);
    const request = work(tx.objectStore('files'));
    tx.oncomplete = () => resolve(request?.result);
  });
}

test('indexedDB stand-in: a record is stored and read back as a copy, with its Blob intact', async () => {
  const db = await openFiles(createIndexedDB());
  const record = { id: 'a', blob: new Blob(['bytes'], { type: 'image/png' }), uploads: {} };
  assert.equal(await inFiles(db, 'readwrite', store => store.put(record)), 'a');
  record.uploads.changedAfterPut = true;
  (await inFiles(db, 'readonly', store => store.get('a'))).uploads.changedAfterGet = true;
  const stored = await inFiles(db, 'readonly', store => store.get('a'));
  assert.deepEqual(stored.uploads, {});
  assert.equal(stored.blob.type, 'image/png');
  assert.equal(await stored.blob.text(), 'bytes');
  assert.equal(await inFiles(db, 'readonly', store => store.get('missing')), undefined);
});

test('indexedDB stand-in: the upgrade callback runs only when the version rises', async () => {
  const indexedDB = createIndexedDB();
  const upgrades = [];
  await inFiles(await openFiles(indexedDB, upgrades), 'readwrite', store => store.put({ id: 'kept' }));
  const reopened = await openFiles(indexedDB, upgrades);
  assert.equal(upgrades.length, 1);
  assert.deepEqual(await inFiles(reopened, 'readonly', store => store.get('kept')), { id: 'kept' });
});

test('indexedDB stand-in: a cursor visits records in key order and can delete as it goes', async () => {
  const db = await openFiles(createIndexedDB());
  for (const id of ['b', 'c', 'a']) await inFiles(db, 'readwrite', store => store.put({ id }));
  const visited = [];
  await inFiles(db, 'readwrite', store => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return visited.push('end');
      visited.push(item.key + '=' + item.value.id);
      item.value.changedInCursor = true;
      if (item.key === 'b') item.delete();
      item.continue();
    };
  });
  assert.deepEqual(visited, ['a=a', 'b=b', 'c=c', 'end']);
  assert.equal(await inFiles(db, 'readonly', store => store.get('b')), undefined);
  assert.deepEqual(await inFiles(db, 'readonly', store => store.get('c')), { id: 'c' });
});

test('indexedDB stand-in: a read-only transaction refuses writes, and a finished one refuses everything', async () => {
  const db = await openFiles(createIndexedDB());
  let finished;
  await inFiles(db, 'readonly', store => {
    finished = store;
    assert.throws(() => store.put({ id: 'a' }), { name: 'ReadOnlyError' });
  });
  assert.throws(() => finished.get('a'), { name: 'TransactionInactiveError' });
});

test('indexedDB stand-in: a store can run on a map handed in, for tests to seed and inspect', async () => {
  const files = new Map([['old', { id: 'old' }]]);
  const db = await openFiles(createIndexedDB(new Map([['db/files', files]])));
  assert.deepEqual(await inFiles(db, 'readonly', store => store.get('old')), { id: 'old' });
  await inFiles(db, 'readwrite', store => store.put({ id: 'new' }));
  assert.deepEqual(Array.from(files.keys()), ['old', 'new']);
});

test('indexedDB stand-in: unknown stores and transaction modes are refused, as a browser refuses them', async () => {
  const db = await openFiles(createIndexedDB());
  assert.throws(() => db.transaction('other', 'readonly'), { name: 'NotFoundError' });
  assert.throws(() => db.transaction('files', 'write'), TypeError);
  assert.throws(() => db.transaction('files', 'readonly').objectStore('other'), { name: 'NotFoundError' });
});
