const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadScripts, jsonResponse, plain, flush } = require('./helpers/scripts.cjs');
const { streamingFetch } = require('./helpers/http.cjs');

/**
 * Http over a fetch the test supplies; `calls` are the [url, options] pairs it was given. `timing` is the
 * time and the timers it sees: the real ones, or those of a manualClock().
 */
function loadHttp(fetcher, timing = { setTimeout, clearTimeout }) {
  const calls = [];
  const context = vm.createContext({
    AbortSignal,
    AbortController,
    TextDecoder,
    ...timing,
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
const encoded = text => new TextEncoder().encode(text);

/** Lets a request take in what the test has just done to it, however many turns of the loop that needs. */
async function settle() {
  for (let turn = 0; turn < 5; turn++) await flush();
}

/**
 * Time the test moves. `globals` are the clock and timers a script is given, advance(ms) lets that much
 * time pass and runs the timers that fall due on the way, in order, and pending() counts the timers still set.
 */
function manualClock() {
  let now = 0;
  let last = 0;
  const timers = new Map();
  return {
    globals: {
      Date: { now: () => now },
      setTimeout(callback, delay) {
        timers.set(++last, { at: now + delay, callback });
        return last;
      },
      clearTimeout: id => timers.delete(id)
    },
    pending: () => timers.size,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = Array.from(timers)
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    }
  };
}

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

test('an answer labelled as an event stream that is JSON after all is read as JSON', async () => {
  for (const [body, data] of [
    ['{"output_text":"whole"}', { output_text: 'whole' }],
    [' \r\n {"a":1}', { a: 1 }],
    ['[{"a":1}]', [{ a: 1 }]]
  ]) {
    const { events, result } = await eventsOf(async () => new Response(body, { headers: eventStream }));
    assert.deepEqual(result, { streamed: false, data }, body);
    assert.deepEqual(events, [], body);
  }
  // What it is shows with its first character, which may not be in the first piece.
  const late = await eventsOf(async () => inPieces([' \n', '{"a"', ':1}'].map(encoded)));
  assert.deepEqual(late.result, { streamed: false, data: { a: 1 } });
  // A stream that opens with blank lines, or carries nothing at all, is still the stream it says it is.
  const blank = await eventsOf(async () => inPieces(['\n\n', 'data: 1\n\n'].map(encoded)));
  assert.deepEqual([blank.events, blank.result], [[['1', 'message']], { streamed: true }]);
  const empty = await eventsOf(async () => new Response('', { headers: eventStream }));
  assert.deepEqual([empty.events, empty.result], [[], { streamed: true }]);
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
  const request = { url: 'https://ai.example/v1', body: {}, onEvent: data => events.push(data) };
  // The limit is on silence, whatever the answer calls itself: six pieces a minute apart outlast it.
  for (const type of ['text/event-stream', 'text/plain']) {
    const clock = manualClock();
    const sent = [];
    const steady = loadHttp(streamingFetch(sent, { type }), clock.globals).http.stream(request);
    for (let index = 0; index < 6; index++) {
      clock.advance(60000);
      sent[0].send('data: ' + index + '\n\n');
      await settle();
    }
    sent[0].end();
    assert.deepEqual(plain(await steady), { streamed: true }, type);
    assert.equal(events.splice(0).length, 6, type + ': the whole stream outlasted the limit without being cut');
    assert.equal(clock.pending(), 0, type + ': no timer is left behind');
  }

  // Unless told otherwise the limit is 90 seconds, counted from the last piece.
  const clock = manualClock();
  const requests = [];
  let timeout;
  loadHttp(streamingFetch(requests), clock.globals)
    .http.stream(request)
    .catch(error => (timeout = error));
  clock.advance(50000);
  requests[0].send('data: first\n\n');
  await settle();
  clock.advance(89999);
  await settle();
  assert.equal(timeout, undefined, 'a moment short of the limit the request is still waiting');
  clock.advance(1);
  await settle();
  assert.deepEqual([timeout.status, timeout.statusText], [0, 'timeout']);
  assert.deepEqual(events, ['first'], 'what arrived before the silence was delivered');
  assert.equal(clock.pending(), 0);

  const unanswered = manualClock();
  const never = failure(loadHttp(untilAborted, unanswered.globals).http.stream({ ...request, idle: 30 }));
  unanswered.advance(30);
  assert.equal((await never).statusText, 'timeout', 'the limit covers the wait for the answer itself');
});

test('a request that has ended leaves no listener on the signal it was given', async () => {
  const listening = new Set();
  const signal = {
    aborted: false,
    addEventListener: (type, listener) => listening.add(listener),
    removeEventListener: (type, listener) => listening.delete(listener)
  };
  const requests = [];
  const reading = loadHttp(streamingFetch(requests)).http.stream({
    url: 'https://ai.example/v1',
    body: {},
    signal,
    onEvent() {}
  });
  assert.equal(listening.size, 1, 'while it runs it listens for the caller stopping it');
  requests[0].end();
  await reading;
  assert.equal(listening.size, 0);
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
  const { http, calls } = loadHttp(async () => new Response('data: 1\n\n', { headers: eventStream }));
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
  assert.equal(calls[0][1].signal.aborted, true, 'the request is given up, not left open with nobody reading');
});
