const test = require('node:test');
const assert = require('node:assert/strict');
const { createChrome } = require('./helpers/chrome.cjs');
const { createDom } = require('./helpers/dom.cjs');

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
