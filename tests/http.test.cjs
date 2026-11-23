const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts, jsonResponse, plain } = require('./helpers/scripts.cjs');

/** Http over a fetch the test supplies; `calls` are the [url, options] pairs it was given. */
function loadHttp(fetcher) {
  const calls = [];
  const context = vm.createContext({
    AbortSignal,
    fetch: (url, options) => {
      calls.push([String(url), options]);
      return fetcher(String(url), options);
    }
  });
  loadScripts(context, ['http']);
  return { http: context.Http, calls };
}

const failure = async promise => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('the request should have failed');
};

test('a JSON answer completes with its data', async () => {
  const { http } = loadHttp(async () => jsonResponse({ name: 'memos/a', tags: ['x'] }));
  assert.deepEqual(plain(await http.json({ url: 'https://memos.example/api/memos/a' })), {
    name: 'memos/a',
    tags: ['x']
  });
});

test('the request carries the method, headers and JSON body, without cookies and with a time limit', async () => {
  const { http, calls } = loadHttp(async () => jsonResponse({}));
  await http.json({
    url: 'https://memos.example/api/memos',
    method: 'POST',
    headers: { Authorization: 'Bearer pat' },
    body: { content: '笔记', visibility: 'PRIVATE' }
  });
  const [url, options] = calls[0];
  assert.equal(url, 'https://memos.example/api/memos');
  assert.equal(options.method, 'POST');
  assert.equal(options.body, JSON.stringify({ content: '笔记', visibility: 'PRIVATE' }));
  assert.deepEqual(
    { ...options.headers },
    { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer pat' }
  );
  assert.equal(options.credentials, 'omit');
  assert.ok(options.signal instanceof AbortSignal);
});

test('a request without a body is a GET that declares no content type, and a caller header wins', async () => {
  const { http, calls } = loadHttp(async () => jsonResponse({}));
  await http.json({ url: 'https://memos.example/api/auth/me', headers: { Accept: 'text/plain' } });
  const options = calls[0][1];
  assert.equal(options.method, 'GET');
  assert.equal(options.body, undefined);
  assert.deepEqual({ ...options.headers }, { Accept: 'text/plain' });
});

test('204 completes without data', async () => {
  const { http } = loadHttp(async () => new Response(null, { status: 204 }));
  assert.equal(await http.json({ url: 'https://memos.example/api/x' }), undefined);
});

test('a successful answer that is not JSON fails with its status and readable headers', async () => {
  const { http } = loadHttp(
    async () =>
      new Response('<!doctype html><title>Memos</title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  );
  const error = await failure(http.json({ url: 'https://memos.example/api/instance/profile' }));
  assert.equal(error.status, 200);
  assert.equal(error.statusText, 'parsererror');
  assert.equal(error.getResponseHeader('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(error.responseJSON, undefined);
  const empty = await failure(loadHttp(async () => new Response('')).http.json({ url: 'https://memos.example/api/x' }));
  assert.equal(empty.status, 200);
});

test('an error answer fails with its status and, when it is JSON, its body', async () => {
  const quota = { code: 8, message: 'quota', details: [{ reason: 'QUOTA_EXCEEDED' }] };
  const { http } = loadHttp(async () => jsonResponse(quota, 429));
  const error = await failure(http.json({ url: 'https://memos.example/api/memos', method: 'POST', body: {} }));
  assert.equal(error.status, 429);
  assert.deepEqual(plain(error.responseJSON), quota);
  assert.equal(error.getResponseHeader('content-type'), 'application/json');
  const gateway = await failure(
    loadHttp(
      async () => new Response('<h1>Bad gateway</h1>', { status: 502, headers: { 'Content-Type': 'text/html' } })
    ).http.json({
      url: 'https://memos.example/api/memos'
    })
  );
  assert.equal(gateway.status, 502);
  assert.equal(gateway.responseJSON, undefined);
  assert.notEqual(gateway.statusText, 'timeout');
});

test('a timeout fails with status 0 and the status text "timeout", also while the body is read', async () => {
  const timeout = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const before = await failure(
    loadHttp(async () => {
      throw timeout();
    }).http.json({ url: 'https://memos.example/api/memos' })
  );
  assert.equal(before.status, 0);
  assert.equal(before.statusText, 'timeout');
  assert.equal(before.getResponseHeader('Content-Type'), null);
  const during = await failure(
    loadHttp(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw timeout();
      }
    })).http.json({ url: 'https://memos.example/api/memos' })
  );
  assert.equal(during.status, 0);
  assert.equal(during.statusText, 'timeout');
});

test('a network error fails with status 0 and is not a timeout', async () => {
  const { http } = loadHttp(async () => {
    throw new TypeError('Failed to fetch');
  });
  const error = await failure(http.json({ url: 'https://memos.example/api/memos' }));
  assert.equal(error.status, 0);
  assert.equal(error.statusText, 'error');
  assert.equal(error.cause.message, 'Failed to fetch', 'what went wrong stays available for diagnosis');
});

test('the time limit given is the one the request is aborted after', async () => {
  const { http } = loadHttp(
    (_, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
      })
  );
  const started = Date.now();
  const error = await failure(http.json({ url: 'https://memos.example/api/memos', timeout: 30 }));
  assert.equal(error.statusText, 'timeout');
  assert.ok(Date.now() - started < 5000);
});
