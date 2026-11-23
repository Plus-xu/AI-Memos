const test = require('node:test');
const assert = require('node:assert/strict');
const { info, loadStagedFiles } = require('./helpers/environments.cjs');

const DAY = 86400000;
const png = (bytes = 'png-bytes') => new Blob([bytes], { type: 'image/png' });
const idOf = markdown => markdown.match(/memos-local:\/\/([a-f0-9-]{36})/)[1];
const fileUrl = (number, name) => 'https://memos.example/file/attachments/file' + number + '/' + name;

/** Answers each attachment upload the way the server does, numbering the files it creates. */
function uploads() {
  let count = 0;
  return options => ({ name: 'attachments/file' + ++count, filename: JSON.parse(options.data).filename });
}

test('staging gives an image an embed and any other file a link, with the name escaped for Markdown', async () => {
  const { staged, files } = loadStagedFiles();
  const image = await staged.stage(png(), 'photo.png');
  const other = await staged.stage(new Blob(['%PDF'], { type: 'application/pdf' }), 'notes [v2]\\final.pdf');
  assert.match(image, /^!\[photo\.png\]\(memos-local:\/\/[0-9a-f-]{36}\)$/);
  assert.equal(other, '[notes \\[v2\\]\\\\final.pdf](memos-local://' + idOf(other) + ')');
  assert.notEqual(idOf(image), idOf(other));
  assert.notEqual(idOf(await staged.stage(png(), 'photo.png')), idOf(image), 'a file added twice is staged twice');
  const stored = files.get(idOf(other));
  assert.equal(stored.name, 'notes [v2]\\final.pdf');
  assert.equal(await stored.blob.text(), '%PDF');
  assert.deepEqual(stored.uploads, {});
  assert.ok(Math.abs(Date.now() - stored.created) < 60000);
});

test('a label replaces the file name in the reference, and line breaks never reach the Markdown', async () => {
  const { staged, files } = loadStagedFiles();
  const labelled = await staged.stage(png(), 'a\nb.png', 'first\r\nsecond');
  assert.ok(labelled.startsWith('![first  second](memos-local://'));
  assert.equal(files.get(idOf(labelled)).name, 'a b.png');
  const unnamed = await staged.stage(png(), '');
  assert.ok(unnamed.startsWith('![attachment](memos-local://'));
});

test('a remote image is refused before any request unless its address is plain http(s) or data', async () => {
  let requests = 0;
  const { staged, files } = loadStagedFiles({
    fetcher: async () => {
      requests++;
      return { ok: true, blob: async () => png() };
    }
  });
  for (const url of [
    'ftp://example.org/a.png',
    'file:///C:/a.png',
    'blob:https://example.org/8a5c',
    'https://user:secret@example.org/a.png',
    'https://user@example.org/a.png',
    'https://:secret@example.org/a.png'
  ])
    await assert.rejects(staged.fromUrl(url), { message: 'imageCaptureFailed' }, url);
  assert.equal(requests, 0);
  assert.equal(files.size, 0);
});

test('a remote image is fetched without credentials or referrer, and only an image response is kept', async () => {
  const requests = [];
  let response = { ok: true, blob: async () => png() };
  const { staged, files } = loadStagedFiles({
    fetcher: async (url, options) => {
      requests.push([String(url), options]);
      return response;
    }
  });
  const markdown = await staged.fromUrl('https://example.org/img/%E5%9B%BE%20(1).png?size=2', '示意图');
  assert.match(markdown, /^!\[示意图\]\(memos-local:\/\/[0-9a-f-]{36}\)$/);
  assert.equal(files.get(idOf(markdown)).name, '图 (1).png');
  const [url, options] = requests[0];
  assert.equal(url, 'https://example.org/img/%E5%9B%BE%20(1).png?size=2');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.ok(options.signal instanceof AbortSignal);
  response = { ok: false, blob: async () => png() };
  await assert.rejects(staged.fromUrl('https://example.org/missing.png'), { message: 'imageCaptureFailed' });
  response = { ok: true, blob: async () => new Blob(['<html>'], { type: 'text/html' }) };
  await assert.rejects(staged.fromUrl('https://example.org/page'), { message: 'imageCaptureFailed' });
  assert.equal(files.size, 1);
});

test('a remote image with no usable file name is named after its type', async () => {
  const types = {
    'http://example.org/': 'image/png',
    'https://example.org/%E5%ZZ': 'image/svg+xml',
    'data:image/gif;base64,R0lGODlh': 'image/gif'
  };
  const { staged, files } = loadStagedFiles({
    fetcher: async url => ({ ok: true, blob: async () => new Blob([String(url)], { type: types[url] }) })
  });
  const names = [];
  for (const url of Object.keys(types)) names.push(files.get(idOf(await staged.fromUrl(url))).name);
  assert.deepEqual(names, ['image.png', 'image.svg', 'image.gif']);
});

test('the same remote image staged again is one file; other bytes, another name or type are separate', async () => {
  let image = png('first');
  const { staged, files } = loadStagedFiles({ fetcher: async () => ({ ok: true, blob: async () => image }) });
  const first = idOf(await staged.fromUrl('https://example.org/a.png'));
  const again = idOf(await staged.fromUrl('https://example.org/a.png'));
  const renamed = idOf(await staged.fromUrl('https://example.org/b.png'));
  image = png('second');
  const changed = idOf(await staged.fromUrl('https://example.org/a.png'));
  image = new Blob(['second'], { type: 'image/webp' });
  const retyped = idOf(await staged.fromUrl('https://example.org/a.png'));
  assert.equal(again, first);
  assert.equal(new Set([first, renamed, changed, retyped]).size, 4);
  assert.equal(files.size, 4);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('a file referenced twice is uploaded once, and both references get its address', async () => {
  const { staged, calls } = loadStagedFiles({ responder: uploads() });
  const id = idOf(await staged.stage(png('image-bytes'), 'photo.png'));
  const resolved = await staged.resolve(
    info,
    `![a](memos-local://${id})\ntext [again](memos-local://${id})`,
    'attempt-1'
  );
  assert.equal(resolved, `![a](${fileUrl(1, 'photo.png')})\ntext [again](${fileUrl(1, 'photo.png')})`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://memos.example/api/attachments');
  assert.equal(calls[0].type, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-pat');
  assert.deepEqual(JSON.parse(calls[0].data), {
    filename: 'photo.png',
    type: 'image/png',
    content: Buffer.from('image-bytes').toString('base64')
  });
});

test('several staged files are each uploaded, and a file without a type goes up as a byte stream', async () => {
  const { staged, calls } = loadStagedFiles({ responder: uploads() });
  const image = await staged.stage(png(), 'photo.png');
  const data = await staged.stage(new Blob(['raw']), 'dump.bin');
  const resolved = await staged.resolve(info, image + '\n' + data, 'attempt-1');
  assert.equal(resolved, `![photo.png](${fileUrl(1, 'photo.png')})\n[dump.bin](${fileUrl(2, 'dump.bin')})`);
  assert.equal(JSON.parse(calls[1].data).type, 'application/octet-stream');
});

// Roadmap item R3 rests on the second half of this: a new attempt uploads the file again.
test('retrying the same save attempt reuses the upload; a new attempt uploads again', async () => {
  const { staged, calls } = loadStagedFiles({ responder: uploads() });
  const markdown = await staged.stage(png(), 'photo.png');
  assert.equal(await staged.resolve(info, markdown, 'attempt-1'), `![photo.png](${fileUrl(1, 'photo.png')})`);
  assert.equal(await staged.resolve(info, markdown, 'attempt-1'), `![photo.png](${fileUrl(1, 'photo.png')})`);
  assert.equal(calls.length, 1);
  assert.equal(await staged.resolve(info, markdown, 'attempt-2'), `![photo.png](${fileUrl(2, 'photo.png')})`);
  assert.equal(calls.length, 2);
});

test('an upload is remembered per account, and staging the same image again keeps what was uploaded', async () => {
  const image = png();
  const { staged, calls } = loadStagedFiles({
    responder: uploads(),
    fetcher: async () => ({ ok: true, blob: async () => image })
  });
  const markdown = await staged.fromUrl('https://example.org/a.png');
  await staged.resolve(info, markdown, 'attempt-1');
  assert.equal(await staged.fromUrl('https://example.org/a.png'), markdown);
  await staged.resolve(info, markdown, 'attempt-1');
  assert.equal(calls.length, 1);
  const other = { ...info, userName: 'users/other' };
  assert.equal(await staged.resolve(other, markdown, 'attempt-1'), `![a.png](${fileUrl(2, 'a.png')})`);
  assert.equal(calls.length, 2);
});

test('text without staged references comes back unchanged, without opening file storage', async () => {
  const { staged, context, calls } = loadStagedFiles();
  context.indexedDB = {
    open() {
      throw new Error('file storage must not be opened');
    }
  };
  const text = 'plain [link](https://example.org) and memos-local://not-an-id';
  assert.equal(await staged.resolve(info, text, 'attempt-1'), text);
  assert.equal(calls.length, 0);
});

test('a reference to a file that is no longer staged fails before anything is uploaded', async () => {
  const { staged, calls } = loadStagedFiles({ responder: uploads() });
  await assert.rejects(
    staged.resolve(info, '![gone](memos-local://00000000-0000-4000-8000-000000000000)', 'attempt-1'),
    { message: 'stagedFileMissing' }
  );
  assert.equal(calls.length, 0);
});

test('an upload that does not come back as a file of this server is refused and not remembered', async () => {
  for (const answer of [
    { name: 'attachments/file1', externalLink: 'https://cdn.example/photo.png' },
    { filename: 'photo.png' }
  ]) {
    const { staged, files } = loadStagedFiles({ responder: () => answer });
    const markdown = await staged.stage(png(), 'photo.png');
    await assert.rejects(staged.resolve(info, markdown, 'attempt-1'), { message: 'stagedFileMissing' });
    assert.deepEqual(files.get(idOf(markdown)).uploads, {});
  }
});

test('collect removes only files older than a week that no draft, review, undo or conflict copy refers to', async () => {
  const names = ['draft', 'stale', 'recent', 'review', 'undo', 'popupConflict', 'panelConflict', 'staleToo'];
  const ids = Object.fromEntries(names.map((name, index) => [name, '00000000-0000-4000-8000-00000000000' + index]));
  const link = name => '![x](memos-local://' + ids[name] + ')';
  const { staged, files } = loadStagedFiles({
    local: {
      memosDraft: { open_action: 'save_text', open_content: 'draft ' + link('draft') },
      memosAIReview: { result: link('review') },
      memosAIUndo: { before: link('undo') },
      'memosDraftConflict:popup': { text: link('popupConflict') },
      'memosDraftConflict:panel': { text: link('panelConflict') }
    }
  });
  for (const name of names) {
    const created = Date.now() - (name === 'recent' ? 6 : 8) * DAY;
    files.set(ids[name], { id: ids[name], blob: png(), name: name + '.png', uploads: {}, created });
  }
  await staged.collect();
  assert.deepEqual(
    Array.from(files.keys()),
    names.filter(name => !name.startsWith('stale')).map(name => ids[name])
  );
});

test('collect keeps a file that only a draft in the old synced location refers to', async () => {
  const id = '00000000-0000-4000-8000-000000000009';
  const { staged, files } = loadStagedFiles({ sync: { open_content: '![x](memos-local://' + id + ')' } });
  files.set(id, { id, blob: png(), name: 'old.png', uploads: {}, created: Date.now() - 30 * DAY });
  await staged.collect();
  assert.deepEqual(Array.from(files.keys()), [id]);
});

test('file storage that cannot be opened is reported, and opening is tried again the next time', async () => {
  const { staged, context } = loadStagedFiles();
  const working = context.indexedDB;
  context.indexedDB = {
    open() {
      const request = { error: new Error('blocked') };
      setImmediate(() => request.onerror());
      return request;
    }
  };
  await assert.rejects(staged.stage(png(), 'photo.png'), { message: 'blocked' });
  context.indexedDB = working;
  assert.ok((await staged.stage(png(), 'photo.png')).startsWith('![photo.png](memos-local://'));
});

test('a write that file storage aborts is reported with its reason, or as a storage failure', async () => {
  const { staged, context } = loadStagedFiles();
  let reason = null;
  context.indexedDB = {
    open() {
      const request = {
        result: {
          transaction() {
            const tx = { error: reason, objectStore: () => ({ put: () => ({}) }) };
            setImmediate(() => tx.onabort());
            return tx;
          }
        }
      };
      setImmediate(() => request.onsuccess());
      return request;
    }
  };
  await assert.rejects(staged.stage(png(), 'photo.png'), { message: 'fileStorageFailed' });
  reason = new Error('QuotaExceededError');
  await assert.rejects(staged.stage(png(), 'photo.png'), { message: 'QuotaExceededError' });
});
