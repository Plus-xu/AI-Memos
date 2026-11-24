const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts, jsonResponse, plain } = require('./helpers/scripts.cjs');
const { streamingFetch } = require('./helpers/http.cjs');

/** Http over a fetch the test supplies; `calls` are the [url, options] pairs it was given. */
function loadHttp(fetcher) {
  const calls = [];
  const context = vm.createContext({
    AbortSignal,
    AbortController,
    TextDecoder,
    setTimeout,
    clearTimeout,
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

test('the request carries the method, headers and JSON body, with a time limit and the cookies the old requests sent', async () => {
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
  // From an extension page with host permissions this sends the site's cookies, as XMLHttpRequest did.
  assert.equal(options.credentials, 'same-origin');
  assert.ok(options.signal instanceof AbortSignal);
});

test('a request without a body is a GET with the same headers, and a caller header wins', async () => {
  const { http, calls } = loadHttp(async () => jsonResponse({}));
  await http.json({ url: 'https://memos.example/api/auth/me', headers: { Accept: 'text/plain' } });
  const options = calls[0][1];
  assert.equal(options.method, 'GET');
  assert.equal(options.body, undefined);
  assert.deepEqual({ ...options.headers }, { Accept: 'text/plain', 'Content-Type': 'application/json' });
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

test('an abort after the time limit is a timeout even where the browser reports it as an AbortError', async () => {
  const { http } = loadHttp(
    (_, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))
        );
      })
  );
  const error = await failure(http.json({ url: 'https://memos.example/api/memos', timeout: 20 }));
  assert.equal(error.status, 0);
  assert.equal(error.statusText, 'timeout');
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

const eventStream = { 'Content-Type': 'text/event-stream; charset=utf-8' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const untilAborted = (_, options) =>
  new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));

/** What stream() hands to onEvent for an answer, as [data, name] pairs, with what it resolved to. */
async function eventsOf(fetcher, options = {}) {
  const events = [];
  const { http, calls } = loadHttp(fetcher);
  const result = await http.stream({
    url: 'https://ai.example/v1/chat/completions',
    body: { stream: true },
    onEvent: (data, name) => events.push([data, name]),
    ...options
  });
  return { events, result: plain(result), calls };
}

/** An answer whose body arrives in the given pieces. */
function inPieces(pieces, headers = eventStream) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      }
    }),
    { headers }
  );
}

test('an event stream is delivered one event at a time, with its name', async () => {
  const body = 'event: a\ndata: 1\n\n: comment\n\nevent: empty\n\ndata: 2\ndata:3\n\n';
  const { events, result } = await eventsOf(async () => new Response(body, { headers: eventStream }));
  assert.deepEqual(events, [
    ['1', 'a'],
    ['2\n3', 'message']
  ]);
  assert.deepEqual(result, { streamed: true });
});

test('events split across chunks, lines, CRLF pairs and multi-byte characters are put back together', async () => {
  // A named event of two lines: a blank line too many would cut it in two and lose its name.
  const bytes = new TextEncoder().encode('event: a\r\ndata: 你好\r\ndata: b\r\n\r\ndata: c\r\n\r\n');
  for (let cut = 1; cut < bytes.length; cut++) {
    const { events } = await eventsOf(async () => inPieces([bytes.slice(0, cut), bytes.slice(cut)]));
    assert.deepEqual(
      events,
      [
        ['你好\nb', 'a'],
        ['c', 'message']
      ],
      'cut at byte ' + cut
    );
  }
  const lone = await eventsOf(async () => new Response('data: a\r\rdata: b\r\r', { headers: eventStream }));
  assert.deepEqual(
    lone.events.map(event => event[0]),
    ['a', 'b'],
    'a lone carriage return ends a line too'
  );
});

test('an event without its closing blank line is still delivered when the stream ends', async () => {
  for (const body of ['data: 1\n\ndata: 2\n', 'data: 1\n\ndata: 2', 'data: 1\n\ndata: 2\r']) {
    const { events } = await eventsOf(async () => new Response(body, { headers: eventStream }));
    assert.deepEqual(
      events.map(event => event[0]),
      ['1', '2'],
      JSON.stringify(body)
    );
  }
});

test('an answer that is not an event stream is parsed as JSON, and a refusal fails as json() does', async () => {
  const whole = await eventsOf(async () => jsonResponse({ output_text: 'whole' }));
  assert.deepEqual(whole.result, { streamed: false, data: { output_text: 'whole' } });
  assert.deepEqual(whole.events, []);
  const { http } = loadHttp(async () => jsonResponse({ error: { message: 'bad model' } }, 400));
  const refused = await failure(http.stream({ url: 'https://ai.example/v1', body: {}, onEvent() {} }));
  assert.equal(refused.status, 400);
  assert.equal(refused.responseJSON.error.message, 'bad model');
  const limited = await failure(
    loadHttp(
      async () => new Response('data: {"error":{"message":"slow down"}}\n\n', { status: 429, headers: eventStream })
    ).http.stream({
      url: 'https://ai.example/v1',
      body: {},
      onEvent() {
        assert.fail('a refusal is not a stream of events, whatever it is labelled or looks like');
      }
    })
  );
  assert.equal(limited.status, 429);
  const page = loadHttp(async () => new Response('<h1>Gateway</h1>', { headers: { 'Content-Type': 'text/html' } }));
  const unreadable = await failure(page.http.stream({ url: 'https://ai.example/v1', body: {}, onEvent() {} }));
  assert.equal(unreadable.status, 200);
  assert.equal(unreadable.statusText, 'parsererror');
  const empty = await eventsOf(async () => new Response(null, { status: 204 }));
  assert.deepEqual(empty.result, { streamed: false }, 'an answer without a body carries no data');
});

test('an event stream under another content type is still read as events, as they arrive', async () => {
  const mislabelled = [
    ['text/plain', ['da', 'ta: {"a":1}\n\n']],
    ['application/json', [': hello\n\ndata: {"a":1}\n\n']]
  ];
  for (const [type, pieces] of mislabelled) {
    const requests = [];
    const events = [];
    const { http } = loadHttp(streamingFetch(requests, { type }));
    const reading = http.stream({
      url: 'https://ai.example/v1',
      body: {},
      onEvent: (data, name) => events.push([data, name])
    });
    for (const piece of pieces) requests[0].send(piece);
    await wait(20);
    assert.deepEqual(events, [['{"a":1}', 'message']], type + ': delivered before the stream ended');
    requests[0].send('data: 2\n\n');
    requests[0].end();
    assert.deepEqual(plain(await reading), { streamed: true });
    assert.deepEqual(
      events.map(event => event[0]),
      ['{"a":1}', '2'],
      type
    );
  }
});

test('a streamed request declares both answer types and carries the same cookies and JSON body as json()', async () => {
  const { calls } = await eventsOf(async () => new Response('', { headers: eventStream }), {
    headers: { Authorization: 'Bearer key' },
    body: { model: 'm', stream: true }
  });
  const [url, options] = calls[0];
  assert.equal(url, 'https://ai.example/v1/chat/completions');
  assert.equal(options.method, 'POST');
  assert.equal(options.body, JSON.stringify({ model: 'm', stream: true }));
  assert.deepEqual(
    { ...options.headers },
    { Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', Authorization: 'Bearer key' }
  );
  assert.equal(options.credentials, 'same-origin');
  assert.ok(options.signal instanceof AbortSignal);
});

test('silence longer than the idle limit is a timeout, while a slow stream that keeps sending is not', async () => {
  const events = [];
  const onEvent = data => events.push(data);
  // The limit is on silence, whatever the answer calls itself.
  for (const type of ['text/event-stream', 'text/plain']) {
    const sent = [];
    const steady = loadHttp(streamingFetch(sent, { type })).http.stream({
      url: 'https://ai.example/v1',
      body: {},
      idle: 240,
      onEvent
    });
    for (let index = 0; index < 6; index++) {
      await wait(70);
      sent[0].send('data: ' + index + '\n\n');
    }
    sent[0].end();
    assert.deepEqual(plain(await steady), { streamed: true }, type);
    assert.equal(events.splice(0).length, 6, type + ': the whole stream outlasted the idle limit without being cut');
  }

  const requests = [];
  const { http } = loadHttp(streamingFetch(requests));
  const silent = http.stream({ url: 'https://ai.example/v1', body: {}, idle: 60, onEvent });
  requests[0].send('data: first\n\n');
  const error = await failure(silent);
  assert.deepEqual([error.status, error.statusText], [0, 'timeout']);
  assert.equal(events.at(-1), 'first', 'what arrived before the silence was delivered');

  const unanswered = loadHttp(untilAborted).http;
  const never = await failure(unanswered.stream({ url: 'https://ai.example/v1', body: {}, idle: 30, onEvent }));
  assert.equal(never.statusText, 'timeout');
});

test('stopping through the caller\'s signal fails with "abort", before the answer and in the middle of it', async () => {
  const early = new AbortController();
  const before = loadHttp(untilAborted).http.stream({
    url: 'https://ai.example/v1',
    body: {},
    signal: early.signal,
    onEvent() {}
  });
  early.abort();
  const first = await failure(before);
  assert.deepEqual([first.status, first.statusText], [0, 'abort']);

  const requests = [];
  const events = [];
  const { http } = loadHttp(streamingFetch(requests));
  const late = new AbortController();
  const during = http.stream({
    url: 'https://ai.example/v1',
    body: {},
    signal: late.signal,
    onEvent: data => {
      events.push(data);
      late.abort();
    }
  });
  requests[0].send('data: partial\n\n');
  const second = await failure(during);
  assert.deepEqual([second.status, second.statusText], [0, 'abort']);
  assert.deepEqual(events, ['partial']);

  const already = new AbortController();
  already.abort();
  const third = await failure(
    http.stream({ url: 'https://ai.example/v1', body: {}, signal: already.signal, onEvent() {} })
  );
  assert.equal(third.statusText, 'abort');
});

test('an error thrown by onEvent is not turned into a request failure', async () => {
  const bug = new Error('a bug in the caller');
  const { http } = loadHttp(async () => new Response('data: 1\n\n', { headers: eventStream }));
  await assert.rejects(
    http.stream({
      url: 'https://ai.example/v1',
      body: {},
      onEvent() {
        throw bug;
      }
    }),
    error => error === bug
  );
});
