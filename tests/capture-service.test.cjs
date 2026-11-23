const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCapture } = require('./helpers/environments.cjs');

const MB = 1024 * 1024;
const tab = { id: 7, url: 'https://example.org/post', title: 'Post' };

/** A page with `count` images, one per line; `image(i)` overrides fields of the i-th. */
function pageWith(count, image = () => ({})) {
  const images = Array.from({ length: count }, (_, i) => ({
    marker: 'MEMOSIMAGE' + i + 'x',
    url: 'https://images.example/' + i + '.png',
    alt: 'image ' + i,
    ...image(i)
  }));
  return { kind: 'article', title: 'Post', url: tab.url, text: images.map(item => item.marker).join('\n'), images };
}

/** An image response of `size` bytes that is never really allocated; `length` is its Content-Length header. */
function imageResponse(size, { length = String(size), type = 'image/png' } = {}) {
  const response = {
    ok: true,
    read: false,
    headers: { get: name => (name.toLowerCase() === 'content-length' ? length : null) },
    blob: async () => {
      response.read = true;
      return { type, size };
    }
  };
  return response;
}

/** Captures `page`, answering each image request with `answer(url)`. `lines` are the draft's quoted lines. */
async function capture(page, answer = () => imageResponse(1000), options = {}) {
  const requests = [],
    responses = [];
  const worker = loadCapture({
    page,
    fetcher: async url => {
      requests.push(String(url));
      const response = await answer(String(url));
      responses.push(response);
      return response;
    },
    ...options
  });
  const result = await worker.capture.add(tab, 'page');
  const lines = worker.local.memosDraft.open_content
    .split('\n')
    .filter(line => line.startsWith('> '))
    .map(line => line.slice(2));
  return { ...worker, result, lines, requests, responses };
}

const staged = /^!\[image \d+\]\(memos-local:\/\/[a-f0-9-]{36}\)$/;

test('a page within the limits stages every image and is not partial', async () => {
  const { result, lines, requests, files } = await capture(pageWith(3));
  assert.equal(result.partial, false);
  assert.equal(result.kind, 'article');
  assert.equal(requests.length, 3);
  assert.equal(files.size, 3);
  for (const line of lines) assert.match(line, staged);
});

test('only the first 30 images of a page are fetched; the others stay as remote images', async () => {
  const { result, lines, requests, files } = await capture(pageWith(40));
  assert.equal(requests.length, 30);
  assert.equal(files.size, 30);
  assert.equal(result.partial, true);
  assert.equal(lines.length, 40);
  for (const line of lines.slice(0, 30)) assert.match(line, staged);
  assert.deepEqual(
    lines.slice(30),
    Array.from({ length: 10 }, (_, i) => '![image ' + (i + 30) + '](https://images.example/' + (i + 30) + '.png)')
  );
});

test('an image over the file limit stays remote while the others are staged', async () => {
  const { result, lines, files } = await capture(pageWith(3), url =>
    imageResponse(url.endsWith('/1.png') ? 30 * MB + 1 : 30 * MB)
  );
  assert.equal(result.partial, true);
  assert.match(lines[0], staged);
  assert.equal(lines[1], '![image 1](https://images.example/1.png)');
  assert.match(lines[2], staged);
  assert.equal(files.size, 2);
});

test("the account's own limit is the one applied to each image", async () => {
  const sync = { apiUrl: 'https://memos.example/', userName: 'users/tester' };
  const scope = JSON.stringify([sync.apiUrl, sync.userName]);
  const local = { memosUploadLimits: { [scope]: { bytes: 2 * MB, at: Date.now() } } };
  const { lines } = await capture(pageWith(2), url => imageResponse(url.endsWith('/0.png') ? 2 * MB : 2 * MB + 1), {
    sync,
    local
  });
  assert.match(lines[0], staged);
  assert.equal(lines[1], '![image 1](https://images.example/1.png)');
});

test('images stop being staged once 60 MB are used, and a smaller one that still fits is taken', async () => {
  const sizes = [25 * MB, 25 * MB, 25 * MB, 10 * MB, 1];
  const { result, lines, files } = await capture(pageWith(5), url =>
    imageResponse(sizes[Number(url.match(/(\d+)\.png/)[1])])
  );
  assert.equal(result.partial, true);
  assert.match(lines[0], staged);
  assert.match(lines[1], staged);
  assert.equal(lines[2], '![image 2](https://images.example/2.png)');
  assert.match(lines[3], staged, '10 MB still fit after 50 MB');
  assert.equal(lines[4], '![image 4](https://images.example/4.png)', 'nothing fits after 60 MB');
  assert.equal(files.size, 3);
});

test('a declared length over the limit is refused without reading the body', async () => {
  const { lines, responses } = await capture(pageWith(1), () => imageResponse(10, { length: String(31 * MB) }));
  assert.equal(responses[0].read, false);
  assert.equal(lines[0], '![image 0](https://images.example/0.png)');
});

test('an image with no declared length, or a false one, is judged by the bytes received', async () => {
  for (const length of [null, '10', 'many']) {
    const { result, lines, responses, files } = await capture(pageWith(1), () => imageResponse(31 * MB, { length }));
    assert.equal(responses[0].read, true);
    assert.equal(result.partial, true);
    assert.equal(lines[0], '![image 0](https://images.example/0.png)');
    assert.equal(files.size, 0);
  }
});

test('an image that cannot be fetched keeps its description, as before, and a data image over the limit too', async () => {
  const failed = await capture(pageWith(1), () => ({ ok: false }));
  assert.equal(failed.result.partial, true);
  assert.deepEqual(failed.lines, ['image 0']);
  const data = await capture(
    pageWith(1, () => ({ url: 'data:image/png;base64,AAAA' })),
    () => imageResponse(31 * MB)
  );
  assert.equal(data.result.partial, true);
  assert.deepEqual(data.lines, ['image 0']);
});

test('a remote image link survives brackets in the description and parentheses in the address', async () => {
  const page = pageWith(1, () => ({ alt: 'a [draft]\\ plan\nv2', url: 'https://images.example/a_(1).png' }));
  const { lines } = await capture(page, () => imageResponse(31 * MB));
  assert.deepEqual(lines, ['![a \\[draft\\]\\\\ plan v2](https://images.example/a_%281%29.png)']);
});

test('a single image clipped from the context menu fails as a whole when it is over the limit', async () => {
  const worker = loadCapture({ fetcher: async () => imageResponse(30 * MB + 1) });
  await assert.rejects(
    worker.capture.add(tab, 'image', { srcUrl: 'https://images.example/big.png', pageUrl: tab.url }),
    { message: 'imageTooLarge' }
  );
  assert.deepEqual(worker.local, {});
  assert.equal(worker.files.size, 0);
  const fits = loadCapture({ fetcher: async () => imageResponse(30 * MB) });
  await fits.capture.add(tab, 'image', { srcUrl: 'https://images.example/ok.png', pageUrl: tab.url });
  assert.match(fits.local.memosDraft.open_content, /!\[ok\.png\]\(memos-local:\/\//);
});
