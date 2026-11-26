const test = require('node:test');
const assert = require('node:assert/strict');
const { plain, jsonResponse } = require('./helpers/scripts.cjs');
const { runtime } = require('./helpers/environments.cjs');
const { streamingFetch } = require('./helpers/http.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = promise =>
  promise.then(
    () => assert.fail('the generation should have failed'),
    error => error
  );

/** One server-sent event. A server that names its events names them after their type. */
const sse = (data, name) =>
  (name ? 'event: ' + name + '\n' : '') + 'data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n';
const named = events => events.map(event => sse(event, event.type));
const unnamed = events => events.map(event => sse(event));

/** What each provider sends for an answer delivered in `pieces` that ends for the reason `finish`. */
const streams = {
  openai: (pieces, finish = 'completed') =>
    named([
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', content: [] } },
      ...pieces.map(delta => ({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta })),
      { type: 'response.' + finish, response: { id: 'resp_1', status: finish } }
    ]),
  deepseek: (pieces, finish = 'stop') =>
    unnamed([
      { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: 'Planning the answer' }, finish_reason: null }] },
      ...pieces.map(content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })),
      { choices: [{ index: 0, delta: { content: '' }, finish_reason: finish }], usage: { completion_tokens: 2 } },
      '[DONE]'
    ]),
  gemini: (pieces, finish = 'STOP') =>
    unnamed([
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Planning', thought: true }] } }] },
      ...pieces.map(text => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }] })),
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '' }] }, finishReason: finish }],
        usageMetadata: { candidatesTokenCount: 2 }
      }
    ]),
  anthropic: (pieces, finish = 'end_turn') =>
    named([
      { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Planning' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      ...pieces.map(text => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })),
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }
    ])
};

/** The events of a stream up to and including the one that delivers `text`. */
const through = (events, text) => events.slice(0, events.findIndex(event => event.includes(text)) + 1);

/**
 * A generation whose answer the test writes: `sent` are the requests, with send(), end() and fail() for
 * their answers, and `seen` is what onText was given.
 */
function generation(provider, options = {}, fetchOptions) {
  const sent = [];
  const seen = [];
  const { ctx, config } = runtime(streamingFetch(sent, fetchOptions));
  const item = config.providers[provider];
  const request = ctx.LLMTransport.request(item, {
    model: 'model-x',
    apiKey: 'fixture-key',
    system: 'Summarise.',
    user: 'A note',
    maxTokens: 1024
  });
  const result = ctx.LLMTransport.generate(item.endpointType, request, { onText: text => seen.push(text), ...options });
  return { sent, seen, result };
}

/** callLLMAPI for Anthropic over answers the test writes. */
function calls() {
  const sent = [];
  const { ctx } = runtime(streamingFetch(sent));
  const call = options =>
    ctx.callLLMAPI('anthropic', 'claude-sonnet-5-5', 'fixture-key', 'A note', 'en', '', 'summary', '', options);
  return { sent, call, ctx };
}

for (const provider of ['openai', 'deepseek', 'gemini', 'anthropic']) {
  test(provider + ' streams text as it arrives and reports a normal end', async () => {
    const { sent, seen, result } = generation(provider);
    const events = streams[provider](['Hel', 'lo']);
    const first = through(events, 'Hel');
    for (const event of first) sent[0].send(event);
    await wait(20);
    assert.deepEqual(seen, ['Hel'], 'the first piece is handed over before the answer is complete');
    for (const event of events.slice(first.length)) sent[0].send(event);
    sent[0].end();
    assert.deepEqual(plain(await result), { text: 'Hello', truncated: false });
    assert.deepEqual(seen, ['Hel', 'Hello']);
    const url = new URL(sent[0].url);
    const body = JSON.parse(sent[0].data);
    if (provider === 'gemini') {
      assert.match(url.pathname, /\/models\/model-x:streamGenerateContent$/);
      assert.equal(url.search, '?alt=sse');
      assert.ok(!Object.hasOwn(body, 'stream'));
    } else {
      assert.equal(url.search, '');
      assert.equal(body.stream, true);
    }
  });
}

test('each protocol reports its own truncation signal', async () => {
  const signals = [
    ['openai', 'incomplete'],
    ['deepseek', 'length'],
    ['gemini', 'MAX_TOKENS'],
    ['gemini', 'CONTINUATION'],
    ['anthropic', 'max_tokens']
  ];
  for (const [provider, finish] of signals) {
    const { sent, result } = generation(provider);
    for (const event of streams[provider](['Hel'], finish)) sent[0].send(event);
    sent[0].end();
    assert.deepEqual(plain(await result), { text: 'Hel', truncated: true }, provider + ' ' + finish);
  }
});

test('an OpenAI stream with no deltas takes its text from the final response', async () => {
  const { sent, seen, result } = generation('openai');
  const response = {
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'Whole answer' }] }
    ]
  };
  sent[0].send(
    sse({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }, 'response.created')
  );
  sent[0].send(sse({ type: 'response.completed', response }, 'response.completed'));
  sent[0].end();
  assert.deepEqual(plain(await result), { text: 'Whole answer', truncated: false });
  assert.deepEqual(seen, ['Whole answer']);
});

test('a gateway that answers whole, or labels its stream as something else, still yields the answer', async () => {
  const { ctx, config } = runtime(async () => jsonResponse({ status: 'incomplete', output_text: 'Whole answer' }));
  const request = ctx.LLMTransport.request(config.providers.openai, { model: 'm', apiKey: 'k', system: '', user: '' });
  assert.deepEqual(plain(await ctx.LLMTransport.generate('openai-responses', request)), {
    text: 'Whole answer',
    truncated: true
  });

  const { sent, result } = generation('deepseek', {}, { type: 'text/plain' });
  for (const event of streams.deepseek(['Hel', 'lo'])) sent[0].send(event);
  sent[0].end();
  assert.deepEqual(plain(await result), { text: 'Hello', truncated: false });

  // The other way round: a whole answer that calls itself an event stream.
  const whole = { choices: [{ finish_reason: 'length', message: { content: 'Whole answer' } }] };
  const labelled = runtime(
    async () => new Response(JSON.stringify(whole), { headers: { 'Content-Type': 'text/event-stream' } })
  );
  const chat = labelled.ctx.LLMTransport.request(labelled.config.providers.deepseek, { model: 'm', apiKey: 'k' });
  assert.deepEqual(plain(await labelled.ctx.LLMTransport.generate('chat-completions', chat)), {
    text: 'Whole answer',
    truncated: true
  });
});

test('a stream that fails, ends without its closing signal or goes silent keeps the text it delivered, marked incomplete', async () => {
  const partial = { text: 'Hel', truncated: true, interrupted: 'interrupted' };
  const begun = async options => {
    const run = generation('anthropic', options);
    for (const event of through(streams.anthropic(['Hel', 'lo']), 'Hel')) run.sent[0].send(event);
    await wait(20);
    return run;
  };

  const broken = await begun();
  broken.sent[0].fail(new TypeError('network error'));
  assert.deepEqual(plain(await broken.result), partial, 'the connection broke');

  const closed = await begun();
  closed.sent[0].end();
  assert.deepEqual(plain(await closed.result), partial, 'the stream closed without saying it was done');

  const refused = await begun();
  refused.sent[0].send(sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'));
  assert.deepEqual(plain(await refused.result), partial, 'the server reported an error in the stream');

  const silent = await begun({ idle: 60 });
  const quiet = Date.now();
  assert.deepEqual(plain(await silent.result), partial, 'nothing more arrived');
  assert.ok(Date.now() - quiet < 5000, 'the silence allowed is the one the caller gave');
});

test('an answer that said it was done is complete, however its connection ends afterwards', async () => {
  const { sent, result } = generation('anthropic');
  for (const event of through(streams.anthropic(['Hello']), 'message_delta')) sent[0].send(event);
  await wait(20);
  sent[0].fail(new TypeError('network error'));
  assert.deepEqual(plain(await result), { text: 'Hello', truncated: false });
});

test("each protocol's error event fails the generation with the reason it gives", async () => {
  const errors = [
    ['openai', sse({ type: 'error', code: 'server_error', message: 'The server had an error' }, 'error')],
    [
      'openai',
      sse(
        {
          type: 'response.failed',
          response: { status: 'failed', error: { code: 'server_error', message: 'Crashed' } }
        },
        'response.failed'
      )
    ],
    ['deepseek', sse({ error: { message: 'Upstream is busy', type: 'server_error' } })],
    ['gemini', sse({ error: { code: 503, message: 'The model is overloaded', status: 'UNAVAILABLE' } })],
    ['anthropic', sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error')],
    // An error may be its reason in words, with nothing else to it.
    ['deepseek', sse({ error: 'The server is out of memory', error_type: 'overloaded' })],
    ['gemini', sse({ error: 'Quota used up' })],
    ['anthropic', sse({ type: 'error', error: 'Gateway timed out' }, 'error')]
  ];
  const reasons = [];
  for (const [provider, event] of errors) {
    const { sent, result } = generation(provider);
    sent[0].send(event);
    const failed = await failure(result);
    assert.deepEqual([failed.status, failed.statusText], [0, 'stream'], provider);
    reasons.push(failed.reason);
  }
  assert.deepEqual(reasons, [
    'The server had an error',
    'Crashed',
    'Upstream is busy',
    'The model is overloaded',
    'Overloaded',
    'The server is out of memory',
    'Quota used up',
    'Gateway timed out'
  ]);
});

test('an event named an error fails the generation without using the text it carries', async () => {
  const errorText = 'Text carried by the error event';
  const endings = {
    openai: { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output_text: errorText } },
    deepseek: { choices: [{ index: 0, delta: { content: errorText }, finish_reason: 'stop' }] },
    gemini: { candidates: [{ index: 0, content: { parts: [{ text: errorText }] }, finishReason: 'STOP' }] },
    anthropic: { type: 'content_block_delta', delta: { type: 'text_delta', text: errorText } }
  };
  for (const provider of Object.keys(endings)) {
    const failed = sse({ ...endings[provider], message: 'Upstream failed' }, 'error');

    const begun = generation(provider);
    for (const event of through(streams[provider](['Hel', 'lo']), 'Hel')) begun.sent[0].send(event);
    begun.sent[0].send(failed);
    assert.deepEqual(
      plain(await begun.result),
      { text: 'Hel', truncated: true, interrupted: 'interrupted' },
      provider + ': the text so far is not a whole answer'
    );

    const empty = generation(provider);
    empty.sent[0].send(failed);
    const lost = await failure(empty.result);
    assert.deepEqual([lost.status, lost.statusText, lost.reason], [0, 'stream', 'Upstream failed'], provider);
    assert.equal(empty.sent.length, 1, provider + ': and nothing is asked again');
  }

  // The line that closes a chat stream is no end either, under that name.
  const closed = generation('deepseek');
  closed.sent[0].send(sse({ choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] }));
  closed.sent[0].send(sse('[DONE]', 'error'));
  assert.deepEqual(plain(await closed.result), { text: 'Hel', truncated: true, interrupted: 'interrupted' });
});

test("the same failures before any text reject, with the provider's reason when it gave one", async () => {
  const { sent, call } = calls();
  const overloaded = call();
  sent[0].send(sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'));
  assert.equal((await failure(overloaded)).message, 'aiInterrupted (Overloaded)');

  const closed = call();
  sent[1].send(sse({ type: 'message_start', message: { id: 'msg_1', content: [] } }, 'message_start'));
  sent[1].end();
  assert.equal((await failure(closed)).message, 'aiInterrupted');

  const wordy = call();
  sent[2].send(sse({ type: 'error', error: { type: 'api_error', message: 'x'.repeat(500) } }, 'error'));
  assert.equal((await failure(wordy)).message, 'aiInterrupted (' + 'x'.repeat(240) + ')');

  const dropped = call();
  sent[3].fail(new TypeError('network error'));
  assert.equal((await failure(dropped)).message, 'aiInterrupted');
});

test('stopping keeps the partial text as "stopped", and rejects as stopped when there is none', async () => {
  const { sent, call } = calls();
  // An answer in `pieces`, of which the events through the one holding `last` have arrived.
  const begin = (pieces, last) => {
    const control = new AbortController();
    const result = call({ signal: control.signal });
    for (const event of through(streams.anthropic(pieces), last)) sent.at(-1).send(event);
    return { control, result };
  };

  const some = begin(['Hel', 'lo'], 'Hel');
  await wait(20);
  some.control.abort();
  assert.deepEqual(plain(await some.result), { text: 'Hel', truncated: true, interrupted: 'stopped' });

  const none = begin(['Hel', 'lo'], 'message_start');
  await wait(20);
  none.control.abort();
  const stopped = await failure(none.result);
  assert.deepEqual([stopped.stopped, stopped.message], [true, 'aiStopped']);

  const marker = begin(['<note>', 'Text'], '<note>');
  await wait(20);
  marker.control.abort();
  assert.equal((await failure(marker.result)).stopped, true, 'an echoed marker alone is not text');
});

test('text shown while streaming never carries an echoed opening marker', async () => {
  const { sent, call } = calls();
  const seen = [];
  const result = call({ onText: text => seen.push(text) });
  for (const event of streams.anthropic(['<note>\n', 'Shown ', 'text', '\n</note>'])) sent[0].send(event);
  sent[0].end();
  assert.deepEqual(plain(await result), { text: 'Shown text', truncated: false });
  assert.deepEqual(seen, ['Shown ', 'Shown text']);
});

test('a gateway address that cannot be used is refused in words, before any request', async () => {
  const sent = [];
  const { ctx } = runtime(streamingFetch(sent));
  ctx.chrome.i18n.getMessage = key => 'Message for ' + key;
  const refused = await failure(
    ctx.callLLMAPI('newapi', 'model-x', 'fixture-key', 'A note', 'en', 'ftp://gateway.test', 'summary', '')
  );
  assert.equal(refused.message, 'Message for modelGatewayUrl');
  assert.equal(sent.length, 0);
});

test('a provider of an unknown type is refused when its request is built', () => {
  const { ctx } = runtime();
  assert.throws(() => ctx.LLMTransport.request({ endpointType: 'telepathy' }, { model: 'm', apiKey: 'k' }));
});

test('a defect in what shows the text is reported as what it is, not as an interrupted request', async () => {
  const { sent, call } = calls();
  const defect = new Error('cannot show the text');
  const result = call({
    onText() {
      throw defect;
    }
  });
  for (const event of through(streams.anthropic(['Hel', 'lo']), 'Hel')) sent[0].send(event);
  assert.equal(await failure(result), defect);
});

test('a chat stream that closes with [DONE] alone is complete, and data that is no event is skipped', async () => {
  const { sent, result } = generation('deepseek');
  const chunk = content => sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  const usageOnly = sse({ choices: [], usage: { completion_tokens: 2 } });
  for (const event of [
    ': keep-alive\n\n',
    chunk('Hel'),
    sse('null'),
    sse('not json'),
    sse('7'),
    chunk('lo'),
    usageOnly
  ])
    sent[0].send(event);
  sent[0].send(sse('[DONE]'));
  sent[0].end();
  assert.deepEqual(plain(await result), { text: 'Hello', truncated: false });
});

test('an answer with an event that cannot be read is missing a part, though the stream says it is done', async () => {
  for (const provider of ['openai', 'deepseek', 'gemini', 'anthropic']) {
    const events = streams[provider](['One. ', 'Two. ', 'Three.']);
    const middle = events.findIndex(event => event.includes('Two. '));
    // The event arrives cut short, as a proxy that drops bytes leaves it.
    events[middle] = events[middle].trimEnd().slice(0, -9) + '\n\n';
    const { sent, result } = generation(provider);
    for (const event of events) sent[0].send(event);
    sent[0].end();
    assert.deepEqual(
      plain(await result),
      { text: 'One. Three.', truncated: true, interrupted: 'interrupted' },
      provider
    );
  }

  const { sent, result } = generation('deepseek');
  for (const event of [sse('{"choices":[{"delta":{"content":"Hel'), sse('[DONE]')]) sent[0].send(event);
  sent[0].end();
  assert.deepEqual(plain(await failure(result)), { status: 0, statusText: 'stream', reason: '' });
});

const asked = { model: 'm', apiKey: 'k', system: 's', user: 'u', maxTokens: 64 };

test('a server that refuses to stream is asked once more, for the answer in one piece', async () => {
  const refusals = [
    [
      'openai',
      400,
      {
        error: {
          message: 'Your organization must be verified to stream this model.',
          type: 'invalid_request_error',
          param: 'stream',
          code: 'unsupported_value'
        }
      },
      { status: 'completed', output_text: 'Whole answer' }
    ],
    [
      'deepseek',
      422,
      { message: 'Streaming is not supported for this model' },
      { choices: [{ finish_reason: 'stop', message: { content: 'Whole answer' } }] }
    ]
  ];
  for (const [provider, status, refusal, whole] of refusals) {
    const bodies = [];
    const { ctx, config } = runtime(async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return bodies.at(-1).stream ? jsonResponse(refusal, status) : jsonResponse(whole);
    });
    const item = config.providers[provider];
    const answer = await ctx.LLMTransport.generate(item.endpointType, ctx.LLMTransport.request(item, asked));
    assert.deepEqual(plain(answer), { text: 'Whole answer', truncated: false }, provider);
    assert.equal(bodies.length, 2, provider);
    assert.ok(!Object.hasOwn(bodies[1], 'stream'), provider + ': the second request does not ask for a stream');
    assert.deepEqual({ ...bodies[1], stream: true }, bodies[0], provider + ': and is otherwise the same request');
  }
});

test('an HTTP 200 JSON error can trigger fallback and the retry reports its own error', async () => {
  const requests = [];
  let whole = {
    choices: [{ finish_reason: 'stop', message: { content: 'Whole answer' } }],
    error: null,
    detail: 'Gateway diagnostic'
  };
  let report = { error: { message: 'Unknown parameter: stream', param: 'stream' } };
  const { ctx } = runtime(async (_url, options) => {
    const streaming = JSON.parse(options.body).stream === true;
    requests.push([streaming, options.headers.Accept]);
    return jsonResponse(streaming ? report : whole);
  });
  const call = () => ctx.callLLMAPI('deepseek', 'm', 'k', 'A note', 'en', '', 'summary', '');
  const expected = [
    [true, 'text/event-stream, application/json'],
    [false, 'application/json']
  ];

  assert.deepEqual(plain(await call()), { text: 'Whole answer', truncated: false });
  assert.deepEqual(requests.splice(0), expected);

  report = { detail: 'Streaming is not supported on this endpoint.' };
  assert.deepEqual(plain(await call()), { text: 'Whole answer', truncated: false });
  assert.deepEqual(requests.splice(0), expected);

  whole = { error: { message: 'Upstream overloaded', code: 503 } };
  assert.equal((await failure(call())).message, 'apiFailed (Upstream overloaded)');
  assert.deepEqual(requests, expected);
});

test('a validation error in an HTTP 200 response still names the rejected field', async () => {
  const validation = field => ({
    detail: [{ loc: ['body', field], type: 'extra_forbidden', msg: 'Extra inputs are not permitted' }]
  });
  const refusals = [
    validation('stream'),
    { object: 'error', type: 'BadRequestError', message: 'Unknown parameter: stream', param: 'stream' }
  ];
  let report;
  const requests = [];
  const { ctx } = runtime(async (_url, options) => {
    const streaming = JSON.parse(options.body).stream === true;
    requests.push([streaming, options.headers.Accept]);
    return streaming
      ? jsonResponse(report)
      : jsonResponse({ choices: [{ message: { content: 'Whole answer' }, finish_reason: 'stop' }] });
  });
  const call = () => ctx.callLLMAPI('deepseek', 'm', 'k', 'A note', 'en', '', 'summary', '');

  for (report of refusals) {
    assert.deepEqual(plain(await call()), { text: 'Whole answer', truncated: false });
    assert.deepEqual(requests.splice(0), [
      [true, 'text/event-stream, application/json'],
      [false, 'application/json']
    ]);
  }

  report = validation('model');
  assert.equal((await failure(call())).message, 'apiFailed (Extra inputs are not permitted)');
  assert.deepEqual(requests, [[true, 'text/event-stream, application/json']]);
});

test('unnamed gateway errors before DONE preserve partial text and mark it interrupted', async () => {
  for (const report of [
    { detail: 'Upstream generation was interrupted.' },
    { choices: [], detail: 'Upstream generation was interrupted.' },
    { success: false, errors: [{ message: 'Upstream generation was interrupted.' }] }
  ]) {
    const { sent, result } = generation('deepseek');
    // A diagnostic beside actual delta text belongs to that event.
    const chunk = { choices: [{ delta: { content: 'First paragraph.' } }], detail: 'Diagnostic' };
    sent[0].send(sse(chunk) + sse(report) + sse('[DONE]'));
    assert.deepEqual(plain(await result), { text: 'First paragraph.', truncated: true, interrupted: 'interrupted' });
    assert.equal(sent.length, 1);
  }
  assert.equal(await requestsWhenStreamSays({ detail: 'Streaming is not supported.' }), 2);
});

test('an explicit HTTP 200 failure retries a stream refusal and surfaces the next gateway error', async () => {
  const flags = [];
  const { ctx } = runtime(async (_url, options) => {
    const streaming = !!JSON.parse(options.body).stream;
    flags.push(streaming);
    return jsonResponse({
      success: false,
      errors: streaming ? [{ message: 'Unsupported parameter: stream' }] : ['No capacity']
    });
  });
  const error = await failure(ctx.callLLMAPI('deepseek', 'm', 'fixture', 'Draft', 'en', '', 'summary', ''));
  assert.equal(error.message, 'apiFailed (No capacity)');
  assert.deepEqual(flags, [true, false]);
});

test('a refusal for another reason, or of both ways of asking, is reported as it is', async () => {
  /** [status, reason, requests made] when every request for `provider` is refused with what refuse(body) gives. */
  const refused = async (provider, status, refuse) => {
    let requests = 0;
    const { ctx, config } = runtime(async (url, options) => {
      requests++;
      return jsonResponse({ error: { message: refuse(JSON.parse(options.body)) } }, status);
    });
    const item = config.providers[provider];
    const failed = await failure(ctx.LLMTransport.generate(item.endpointType, ctx.LLMTransport.request(item, asked)));
    return [failed.status, failed.responseJSON.error.message, requests];
  };
  assert.deepEqual(await refused('openai', 400, () => 'max_output_tokens is too large'), [
    400,
    'max_output_tokens is too large',
    1
  ]);
  assert.deepEqual(
    await refused('openai', 400, body => (body.stream ? 'Streaming is not available' : 'The model does not exist')),
    [400, 'The model does not exist', 2],
    'what the plain request was refused for is what the user needs to know'
  );
  assert.deepEqual(
    await refused('openai', 400, () => 'No streaming here'),
    [400, 'No streaming here', 2],
    'a server that goes on refusing is not asked for ever'
  );
  assert.deepEqual(
    await refused('openai', 500, () => 'The stream handler crashed'),
    [500, 'The stream handler crashed', 1],
    'a failing server is not a refusal'
  );
  assert.deepEqual(
    await refused('gemini', 400, () => 'Streaming is not enabled'),
    [400, 'Streaming is not enabled', 2],
    'Gemini is asked twice too, and no more'
  );
});

test('Gemini refused its streaming method is asked by the one that answers in one piece', async () => {
  const requests = [];
  const { ctx, config } = runtime(async (url, options) => {
    requests.push({ url: new URL(url), body: options.body, accept: options.headers.Accept });
    return requests.length === 1
      ? jsonResponse({ error: { code: 400, message: 'Streaming is not supported', status: 'INVALID_ARGUMENT' } }, 400)
      : jsonResponse({ candidates: [{ content: { parts: [{ text: 'Whole answer' }] }, finishReason: 'STOP' }] });
  });
  const request = ctx.LLMTransport.request(config.providers.gemini, asked);
  const answer = await ctx.LLMTransport.generate('gemini', request);
  assert.deepEqual(plain(answer), { text: 'Whole answer', truncated: false });
  assert.equal(requests.length, 2);
  assert.match(requests[0].url.pathname, /\/models\/m:streamGenerateContent$/);
  assert.match(requests[1].url.pathname, /\/models\/m:generateContent$/);
  assert.equal(requests[1].url.search, '');
  assert.equal(requests[1].accept, 'application/json');
  assert.equal(requests[1].body, requests[0].body, 'the same request otherwise');

  // An address of the user's own that is not the streaming method has no other method to fall back to.
  let made = 0;
  const custom = runtime(async () => (made++, jsonResponse({ error: { message: 'Streaming is not supported' } }, 400)));
  const own = custom.ctx.LLMTransport.request(custom.config.providers.gemini, {
    ...asked,
    apiUrl: 'https://gateway.example/v1/gemini'
  });
  await failure(custom.ctx.LLMTransport.generate('gemini', own));
  assert.equal(made, 1);
});

test('the text of the finished OpenAI response stands for the answer, whatever the deltas brought', async () => {
  const finished = text => ({ type: 'response.completed', response: { status: 'completed', output_text: text } });
  const delta = text => sse({ type: 'response.output_text.delta', delta: text }, 'response.output_text.delta');

  const some = generation('openai');
  some.sent[0].send(delta('One. '));
  some.sent[0].send(sse(finished('One. Two. Three.'), 'response.completed'));
  some.sent[0].end();
  assert.deepEqual(plain(await some.result), { text: 'One. Two. Three.', truncated: false }, 'only some deltas');

  const damaged = generation('openai');
  damaged.sent[0].send(delta('One. '));
  damaged.sent[0].send(delta('Two. ').trimEnd().slice(0, -5) + '\n\n');
  damaged.sent[0].send(delta('Three.'));
  damaged.sent[0].send(sse(finished('One. Two. Three.'), 'response.completed'));
  damaged.sent[0].end();
  assert.deepEqual(
    plain(await damaged.result),
    { text: 'One. Two. Three.', truncated: false },
    'a damaged delta is made up for'
  );
  assert.equal(damaged.seen.at(-1), 'One. Two. Three.');
});

test('a refusal that says to turn streaming off is asked once more', async () => {
  const repeated = [
    'Please set stream to false',
    'Please set stream=false for this model',
    'This model requires stream=false',
    'stream should be false',
    'Set "stream": false to use this model',
    'Please disable streaming',
    'Please turn off streaming for this model',
    'Streaming must be turned off',
    'Use stream: false',
    'Retry without streaming',
    '请关闭流式输出',
    '请将 stream 设置为 false',
    '请使用非流式请求',
    'stream 必须为 false'
  ];
  const single = [
    'The stream was turned off by the upstream server',
    'logprobs must be false for this model',
    'Set "store": false to use this model',
    'The stream request is missing a field: messages'
  ];
  for (const message of repeated) assert.equal(await requestsWhenRefused(400, { error: { message } }), 2, message);
  for (const message of repeated)
    assert.equal(await requestsWhenRefused(400, message), 2, 'in plain words: ' + message);
  for (const message of single) assert.equal(await requestsWhenRefused(400, { error: { message } }), 1, message);
});

test('a chat gateway that sends the whole answer as its one event still yields it', async () => {
  const { sent, seen, result } = generation('deepseek');
  const message = { role: 'assistant', content: 'Whole answer' };
  sent[0].send(sse({ object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }] }));
  sent[0].send(sse('[DONE]'));
  sent[0].end();
  assert.deepEqual(plain(await result), { text: 'Whole answer', truncated: false });
  assert.deepEqual(seen, ['Whole answer']);
});

test('a prompt Gemini blocks is an answer without text, not an interrupted request', async () => {
  const sent = [];
  const { ctx } = runtime(streamingFetch(sent));
  const blocked = ctx.callLLMAPI('gemini', 'gemini-4-hydrogen', 'fixture-key', 'A note', 'en', '', 'summary', '');
  const feedback = { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT' }] };
  sent[0].send(sse({ promptFeedback: feedback, usageMetadata: { promptTokenCount: 9 } }));
  sent[0].end();
  assert.equal((await failure(blocked)).message, 'aiEmpty');
});

test('an answer the provider ended for another reason than being finished keeps its text, marked as ended early', async () => {
  const cut = { text: 'Hel', truncated: true, interrupted: 'ended' };
  const reasons = [
    ['deepseek', 'content_filter'],
    ['deepseek', 'insufficient_system_resource'],
    ['deepseek', 'a_reason_added_later'],
    ['gemini', 'SAFETY'],
    ['gemini', 'RECITATION'],
    ['anthropic', 'refusal'],
    ['anthropic', 'pause_turn']
  ];
  for (const [provider, finish] of reasons) {
    const { sent, result } = generation(provider);
    for (const event of streams[provider](['Hel'], finish)) sent[0].send(event);
    sent[0].end();
    assert.deepEqual(plain(await result), cut, provider + ' ' + finish);
  }

  // OpenAI says what cut an incomplete response: the output limit is one reason, a filter another.
  const incomplete = reason => {
    const response = { status: 'incomplete', incomplete_details: { reason } };
    return sse({ type: 'response.incomplete', response }, 'response.incomplete');
  };
  const delta = sse({ type: 'response.output_text.delta', delta: 'Hel' }, 'response.output_text.delta');
  const filtered = generation('openai');
  for (const event of [delta, incomplete('content_filter')]) filtered.sent[0].send(event);
  assert.deepEqual(plain(await filtered.result), cut);
  const limited = generation('openai');
  for (const event of [delta, incomplete('max_output_tokens')]) limited.sent[0].send(event);
  assert.deepEqual(plain(await limited.result), { text: 'Hel', truncated: true });

  // The same holds for an answer that arrives in one piece.
  const whole = { choices: [{ finish_reason: 'content_filter', message: { content: 'Hel' } }] };
  const { ctx, config } = runtime(async () => jsonResponse(whole));
  const request = ctx.LLMTransport.request(config.providers.deepseek, asked);
  assert.deepEqual(plain(await ctx.LLMTransport.generate('chat-completions', request)), cut);
});

test('an answer is complete with the event that ends it, though the server keeps the connection alive', async () => {
  for (const provider of ['openai', 'deepseek', 'gemini', 'anthropic']) {
    const { sent, result } = generation(provider);
    for (const event of streams[provider](['Hel', 'lo'])) sent[0].send(event);
    const beating = setInterval(() => sent[0].send(': keep-alive\n\n'), 5);
    try {
      const answer = await Promise.race([result, wait(1000).then(() => 'still generating')]);
      assert.deepEqual(plain(answer), { text: 'Hello', truncated: false }, provider);
    } finally {
      clearInterval(beating);
      sent[0].end();
    }
  }
});

test('a refusal to stream in plain words is asked once more, and an upstream error is not taken for one', async () => {
  const bodies = [];
  const plainly = runtime(async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return bodies.at(-1).stream
      ? new Response('This model does not support streaming', { status: 400 })
      : jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Whole answer' } }] });
  });
  const request = plainly.ctx.LLMTransport.request(plainly.config.providers.deepseek, asked);
  const answer = await plainly.ctx.LLMTransport.generate('chat-completions', request);
  assert.deepEqual(plain(answer), { text: 'Whole answer', truncated: false });
  assert.equal(bodies.length, 2);

  for (const refusal of [
    jsonResponseOf => jsonResponseOf({ error: { type: 'upstream_error', message: 'Bad gateway' } }, 400),
    () => new Response('upstream connect error', { status: 400 })
  ]) {
    let requests = 0;
    const { ctx, config } = runtime(async () => {
      requests++;
      return refusal(jsonResponse);
    });
    const failed = await failure(
      ctx.LLMTransport.generate('chat-completions', ctx.LLMTransport.request(config.providers.deepseek, asked))
    );
    assert.deepEqual([failed.status, requests], [400, 1]);
  }
});

test('an answer the provider ended early with nothing to show is an empty answer, not a lost connection', async () => {
  const { sent, call } = calls();
  const filtered = call();
  for (const event of streams.anthropic(['<note>\n'], 'refusal')) sent[0].send(event);
  assert.equal((await failure(filtered)).message, 'aiEmpty');
});

/** How many requests a chat generation makes when each is refused with `status` and `body`, text or JSON. */
async function requestsWhenRefused(status, body) {
  let requests = 0;
  const { ctx, config } = runtime(async () => {
    requests++;
    return typeof body === 'string' ? new Response(body, { status }) : jsonResponse(body, status);
  });
  const request = ctx.LLMTransport.request(config.providers.deepseek, {
    ...asked,
    user: 'A note on stream processing'
  });
  await failure(ctx.LLMTransport.generate('chat-completions', request));
  return requests;
}

/**
 * How many requests a chat generation makes when the stream it asks for opens and says `event`, an error, and
 * a request for the answer in one piece gets it.
 */
async function requestsWhenStreamSays(event) {
  let requests = 0;
  const { ctx, config } = runtime(async (url, options) => {
    requests++;
    return JSON.parse(options.body).stream
      ? new Response(sse(event), { headers: { 'Content-Type': 'text/event-stream' } })
      : jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Whole answer' } }] });
  });
  const request = ctx.LLMTransport.request(config.providers.deepseek, {
    ...asked,
    user: 'A note on stream processing'
  });
  const outcome = await ctx.LLMTransport.generate('chat-completions', request).then(
    answer => answer.text,
    failed => failed.statusText
  );
  // The error the stream reported, or the answer to the second request: anything else is a defect.
  assert.equal(outcome, requests === 1 ? 'stream' : 'Whole answer', JSON.stringify(event));
  return requests;
}

test('only the reason a refusal gives decides whether the request is repeated without its stream flag', async () => {
  const echoed = { model: 'm', stream: true, messages: [{ role: 'user', content: 'A note on stream processing' }] };
  const repeated = [
    ['a refusal in Chinese', { error: { message: '当前模型不支持流式输出' } }],
    ['a refusal that names SSE', { error: { message: 'SSE is not supported' } }],
    ['a refusal in an error that is a string', { error: 'Streaming is disabled' }],
    ['a refusal by code alone', { error: { message: 'Unsupported value', code: 'stream_not_supported' } }],
    ['a refusal in plain words that repeats the flag', 'Streaming is unavailable. Request: {"stream": true}']
  ];
  const single = [
    ['an invalid model whose error repeats the request', { error: { message: 'Invalid model' }, request: echoed }],
    ['the same with the request inside the error', { error: { message: 'Invalid model', request: echoed } }],
    ['the same in plain words', 'Invalid model. Request: {"model":"m","stream":true}'],
    ['a reason that only contains the letters', { error: { message: 'An ESSENTIAL field is missing' } }]
  ];
  for (const [what, body] of repeated) assert.equal(await requestsWhenRefused(400, body), 2, what);
  for (const [what, body] of single) assert.equal(await requestsWhenRefused(400, body), 1, what);
});

test('an error that only mentions the stream request, without refusing to stream, is not asked again', async () => {
  const tooLong =
    "This model's maximum context length is 8192 tokens. However, your stream request resulted in 9001 tokens. " +
    'Please reduce the length of the messages.';
  const single = [
    ['a context too long, in plain words', tooLong],
    [
      'the same as an error with its fields',
      { error: { message: tooLong, type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } }
    ],
    [
      'an invalid request that is called a stream request',
      { error: { message: 'Invalid stream request: prompt is too long' } }
    ],
    ['the same in Chinese', { error: { message: '流式请求的上下文长度超出模型上限' } }],
    [
      'a refusal of something else beside a mention of the stream',
      { error: { message: 'Failed to start the stream request. The model m is not supported.' } }
    ]
  ];
  const repeated = [
    ['a parameter that is not known', { error: { message: 'Unknown parameter: stream' } }],
    ['a code that ends in the name', { error: { message: 'Bad request', code: 'unsupported_stream' } }],
    ['a value the flag must have', { error: { message: 'stream must be false for this model' } }],
    ['a refusal beside another sentence', tooLong.replace('Please', 'Streaming is not supported. Please')],
    ['streaming had only on another tier', { error: { message: 'Streaming is supported only on the standard tier.' } }],
    ['the same in plain words', 'Streaming is only available on the standard tier.'],
    ['the same in Chinese', { error: { message: '流式输出仅支持标准版' } }],
    ['a model that does not stream', { error: { message: 'The model m is not available for streaming.' } }]
  ];
  single.push([
    'a model that is not to be had, in an error that calls the request a streaming request',
    {
      error: {
        message: 'The model m does not exist or is not available for your streaming request.',
        code: 'model_not_found'
      }
    }
  ]);
  for (const [what, body] of single) assert.equal(await requestsWhenRefused(400, body), 1, what);
  for (const [what, body] of repeated) assert.equal(await requestsWhenRefused(400, body), 2, what);
});

test('a gateway that answers 406 to a request that takes an event stream is asked for JSON alone', async () => {
  const refusals = [
    () => jsonResponse({ error: { message: 'Accept header must be application/json' } }, 406),
    () => new Response('Not Acceptable', { status: 406 }),
    () => new Response('', { status: 406 })
  ];
  for (const refusal of refusals) {
    const accepts = [];
    const { ctx, config } = runtime(async (url, options) => {
      accepts.push(options.headers.Accept);
      return /event-stream/.test(options.headers.Accept)
        ? refusal()
        : jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Whole answer' } }] });
    });
    const request = ctx.LLMTransport.request(config.providers.deepseek, asked);
    const answer = await ctx.LLMTransport.generate('chat-completions', request);
    assert.deepEqual(plain(answer), { text: 'Whole answer', truncated: false });
    assert.deepEqual(accepts, ['text/event-stream, application/json', 'application/json']);
  }
  assert.equal(await requestsWhenRefused(406, 'Not Acceptable'), 2, 'a gateway that goes on refusing is asked twice');
});

test('the request repeated without its stream flag asks for JSON alone', async () => {
  const accepts = [];
  const { ctx, config } = runtime(async (url, options) => {
    accepts.push(options.headers.Accept);
    // A gateway that decides by what the request says it takes.
    return /event-stream/.test(options.headers.Accept)
      ? jsonResponse({ error: { message: 'Streaming is not supported' } }, 400)
      : jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Whole answer' } }] });
  });
  const request = ctx.LLMTransport.request(config.providers.deepseek, asked);
  const answer = await ctx.LLMTransport.generate('chat-completions', request);
  assert.deepEqual(plain(answer), { text: 'Whole answer', truncated: false });
  assert.deepEqual(accepts, ['text/event-stream, application/json', 'application/json']);
});

test('a refusal to stream is recognised wherever and however the server words it', async () => {
  const note = '<note>\nA note on stream processing\n</note>';
  /** How many requests are made when each is refused with what refuse(body, text of the body) gives. */
  const requests = async (status, refuse) => {
    let made = 0;
    const { ctx, config } = runtime(async (url, options) => {
      made++;
      const body = refuse(JSON.parse(options.body), options.body);
      return typeof body === 'string' ? new Response(body, { status }) : jsonResponse(body, status);
    });
    const request = ctx.LLMTransport.request(config.providers.deepseek, { ...asked, user: note });
    await failure(ctx.LLMTransport.generate('chat-completions', request));
    return made;
  };
  const extra = { type: 'extra_forbidden', loc: ['body', 'stream'], msg: 'Extra inputs are not permitted' };
  const refusals = [
    ['the field named in a validation error', 422, () => ({ detail: [{ ...extra, input: true }] })],
    ['the same inside a message', 422, () => ({ object: 'error', message: { detail: [extra] } })],
    ['the flag quoted as the reason', 400, () => ({ error: { message: 'Unsupported parameter "stream": true' } })],
    ['the same in plain words', 400, () => 'Unsupported parameter "stream": true'],
    [
      'a list of errors',
      400,
      () => ({ success: false, errors: [{ code: 7001, message: 'Streaming is not supported' }] })
    ],
    ['errors keyed by field', 400, () => ({ stream: ['This field is not allowed.'] })],
    ['an answer that is a list', 400, () => [{ error: { code: 400, message: 'Streaming is not supported' } }]],
    [
      'a reason passed on from upstream',
      400,
      () => ({ error: { message: 'Provider returned error', metadata: { raw: 'streaming is not supported' } } })
    ],
    [
      'the type of the error alone',
      400,
      () => ({ error: { message: 'Unsupported', type: 'streaming_not_supported' } })
    ],
    ['a problem document', 400, () => ({ type: 'about:blank', title: 'Streaming not supported', status: 400 })],
    ['server-sent events by name', 400, () => ({ error: { message: 'Server-sent events are not available' } })]
  ];
  const others = [
    ['the request repeated in plain words', 400, (body, raw) => 'Invalid model. Request: ' + raw],
    [
      'the request repeated in the message',
      400,
      (body, raw) => ({ error: { message: 'Invalid model. Request: ' + raw } })
    ],
    [
      'the note quoted in the message',
      400,
      body => ({ error: { message: 'Invalid model for ' + JSON.stringify(body.messages[1].content) } })
    ],
    ['the request beside the error', 400, body => ({ error: { message: 'Invalid model' }, request: body })],
    [
      'the request as the rejected input',
      422,
      body => ({ detail: [{ type: 'model_type', loc: ['body'], msg: 'Not a model', input: body }] })
    ],
    ['the request written out again', 400, body => 'Invalid model. Request: ' + JSON.stringify(body, null, 1)],
    ['the request as a Python dict', 400, () => "Invalid model. Request: {'model': 'm', 'stream': True}"]
  ];
  for (const [what, status, refuse] of refusals) assert.equal(await requests(status, refuse), 2, what);
  for (const [what, status, refuse] of others) assert.equal(await requests(status, refuse), 1, what);
});

test('a refusal to stream that arrives as an event of the stream is asked once more too', async () => {
  const wholes = {
    openai: { status: 'completed', output_text: 'Whole answer' },
    deepseek: { choices: [{ finish_reason: 'stop', message: { content: 'Whole answer' } }] },
    gemini: { candidates: [{ content: { parts: [{ text: 'Whole answer' }] }, finishReason: 'STOP' }] },
    anthropic: { content: [{ type: 'text', text: 'Whole answer' }], stop_reason: 'end_turn' }
  };
  /**
   * The requests made, and the answer, when each request of `provider` for a stream is answered with `events`.
   * `input` is what the generation is asked for.
   */
  const answered = (provider, events, input = asked) => {
    const requests = [];
    const { ctx, config } = runtime(async (url, options) => {
      const streaming = !!JSON.parse(options.body).stream || /:streamGenerateContent/.test(url);
      requests.push({ streaming, accept: options.headers.Accept });
      return streaming
        ? new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } })
        : jsonResponse(wholes[provider]);
    });
    const item = config.providers[provider];
    return { requests, result: ctx.LLMTransport.generate(item.endpointType, ctx.LLMTransport.request(item, input)) };
  };
  const unverified = {
    type: 'error',
    code: 'unsupported_value',
    message: 'Your organization must be verified to stream this model.',
    param: 'stream'
  };
  const failed = { status: 'failed', error: { code: 'stream_not_supported', message: 'Unsupported value' } };
  const refusals = [
    ['openai', 'by the parameter it names', sse(unverified, 'error')],
    [
      'openai',
      'by the code of a failed response',
      sse({ type: 'response.failed', response: failed }, 'response.failed')
    ],
    ['deepseek', 'in words', sse({ error: { message: 'Streaming is not supported for this model' } })],
    ['deepseek', 'in an error that is a string', sse({ error: 'Streaming is disabled' })],
    // The name of the event alone says it is an error: its data has no shape the protocol knows.
    ['deepseek', 'in an event named error', sse({ message: 'Streaming is not supported for this model' }, 'error')],
    ['deepseek', 'in an event named error that is plain text', sse('Streaming is not supported', 'error')],
    ['gemini', 'in an event named error', sse({ detail: 'Streaming is not supported' }, 'error')],
    [
      'gemini',
      'in words',
      sse({ error: { code: 400, message: 'Streaming is not supported', status: 'INVALID_ARGUMENT' } })
    ],
    [
      'anthropic',
      'in words',
      sse({ type: 'error', error: { type: 'invalid_request_error', message: 'Streaming is not supported' } }, 'error')
    ],
    // What refuses may stand beside the error in the event, not inside it.
    [
      'openai',
      'by a parameter beside the error of a failed response',
      sse({ type: 'response.failed', response: { status: 'failed', error: 'Unsupported value' }, param: 'stream' })
    ],
    ['deepseek', 'by a parameter beside the error', sse({ error: { message: 'Unsupported value' }, param: 'stream' })],
    ['deepseek', 'by a code beside an error in words', sse({ error: 'Bad request', code: 'stream_not_supported' })],
    [
      'gemini',
      'in words beside the error',
      sse({ error: { code: 400, status: 'INVALID_ARGUMENT' }, message: 'Streaming is not supported' })
    ],
    [
      'anthropic',
      'by a parameter beside the error',
      sse({ type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported value' }, param: 'stream' })
    ]
  ];
  for (const [provider, how, event] of refusals) {
    const { requests, result } = answered(provider, [event]);
    const answer = await result.catch(error => error);
    assert.deepEqual(plain(answer), { text: 'Whole answer', truncated: false }, provider + ' ' + how);
    assert.deepEqual(
      requests,
      [
        { streaming: true, accept: 'text/event-stream, application/json' },
        { streaming: false, accept: 'application/json' }
      ],
      provider + ' ' + how
    );
  }

  // An error for another reason is the failure it was, and is not asked about again.
  const busy = answered('deepseek', [sse({ error: { message: 'Upstream is busy', type: 'server_error' } })]);
  const lost = await failure(busy.result);
  assert.deepEqual([lost.status, lost.statusText, lost.reason], [0, 'stream', 'Upstream is busy']);
  assert.equal(busy.requests.length, 1);

  // So is one that an event says by its name alone.
  const named = answered('deepseek', [sse({ message: 'Upstream is busy' }, 'error')]);
  const unnamed = await failure(named.result);
  assert.deepEqual([unnamed.status, unnamed.statusText, unnamed.reason], [0, 'stream', 'Upstream is busy']);
  assert.equal(named.requests.length, 1);

  // Nor is one that arrives in a chunk of the answer: what else the chunk carries refuses nothing.
  const chunk = {
    id: 'gen-1',
    object: 'chat.completion.chunk',
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'error' }],
    error: { code: 'server_error', message: 'Provider disconnected' }
  };
  const midway = answered('deepseek', [sse(chunk)]);
  assert.equal((await failure(midway.result)).reason, 'Provider disconnected');
  assert.equal(midway.requests.length, 1);

  // A response that failed repeats what it was asked: words of the request refuse nothing, here either.
  const system = 'Summarise. Streaming is not supported by the reader of this note.';
  const response = {
    id: 'resp_1',
    object: 'response',
    status: 'failed',
    error: { code: 'server_error', message: 'The model failed to generate a response.' },
    instructions: system,
    model: 'm',
    output: [],
    truncation: 'disabled'
  };
  const crashed = answered('openai', [sse({ type: 'response.failed', response }, 'response.failed')], {
    ...asked,
    system
  });
  assert.equal((await failure(crashed.result)).reason, 'The model failed to generate a response.');
  assert.equal(crashed.requests.length, 1);

  // A stream that timed out on the server was a stream: its code names it without refusing it.
  const timeouts = [
    { error: { message: 'Stream timed out', code: 'stream_timeout' } },
    { error: { message: 'The upstream went silent', type: 'stream_idle_timeout' } },
    { error: { message: 'Connection lost', code: 'stream_error' } }
  ];
  for (const timeout of timeouts) {
    const slow = answered('deepseek', [sse(timeout)]);
    assert.equal((await failure(slow.result)).statusText, 'stream', timeout.error.message);
    assert.equal(slow.requests.length, 1, timeout.error.message);
  }

  // A server that has sent text does stream: what it sent is kept, whatever it says afterwards.
  const begun = answered('deepseek', [
    sse({ choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] }),
    sse({ error: { message: 'Streaming is not supported for this model' } })
  ]);
  assert.deepEqual(plain(await begun.result), { text: 'Hel', truncated: true, interrupted: 'interrupted' });
  assert.equal(begun.requests.length, 1);
});

test('the stream flag named as the rejected parameter in text passed on from upstream is a refusal to stream', async () => {
  const unverified = {
    message: 'Your organization must be verified to stream this model.',
    type: 'invalid_request_error',
    param: 'stream',
    code: 'unsupported_value'
  };
  const dict =
    "{'error': {'message': 'Your organization must be verified to stream this model.', " +
    "'type': 'invalid_request_error', 'param': 'stream', 'code': 'unsupported_value'}}";
  const upstream = raw => ({ error: { message: 'Provider returned error', code: 400, metadata: { raw } } });
  const repeated = [
    ['the upstream error as JSON in a field', upstream(JSON.stringify({ error: unverified }))],
    ['the same as JSON in the message', { error: { message: JSON.stringify({ error: unverified }) } }],
    [
      'the upstream error written out as a Python dict',
      { error: { message: 'BadRequestError: OpenAIException - Error code: 400 - ' + dict, code: '400' } }
    ],
    ['a refusal framed as an event', 'data: ' + JSON.stringify({ error: unverified }) + '\n\n']
  ];
  const echoed = { model: 'm', stream: true, messages: [{ role: 'user', content: 'A note on stream processing' }] };
  const wrongModel = { message: 'Invalid model', type: 'invalid_request_error', param: 'model' };
  const single = [
    ['another parameter named the same way', upstream(JSON.stringify({ error: wrongModel }))],
    [
      'the request repeated inside the upstream error',
      upstream(JSON.stringify({ error: wrongModel, request: echoed }))
    ],
    [
      'another parameter in a Python dict',
      { error: { message: "Error code: 400 - {'error': {'message': 'Invalid model', 'param': 'model'}}" } }
    ]
  ];
  for (const [what, body] of repeated) assert.equal(await requestsWhenRefused(400, body), 2, what);
  for (const [what, body] of single) assert.equal(await requestsWhenRefused(400, body), 1, what);
});

test('a forwarded upstream disconnect takes precedence over the stream parameter it names', async () => {
  const disconnected = {
    error: {
      code: 502,
      message: 'The upstream connection closed without streaming any output',
      metadata: { error_type: 'provider_disconnected' }
    },
    param: 'stream'
  };
  const dict =
    "{'error': {'code': 502, 'message': 'The upstream connection closed without streaming any output', " +
    "'metadata': {'error_type': 'provider_disconnected'}}, 'param': 'stream'}";
  for (const raw of [
    disconnected,
    [disconnected],
    JSON.stringify(disconnected),
    JSON.stringify([disconnected]),
    dict
  ]) {
    const forwarded = { error: { message: 'Provider returned error', metadata: { raw } } };
    assert.equal(await requestsWhenStreamSays(forwarded), 1, 'in an event');
    assert.equal(await requestsWhenRefused(200, forwarded), 1, 'in an HTTP 200 JSON response');
    assert.equal(await requestsWhenRefused(400, forwarded), 1, 'in an HTTP error response');
  }
});

test('structured HTTP and RPC timeouts take precedence over a stream refusal phrase', async () => {
  const message = 'The upstream request timed out without streaming a single token.';
  const errors = [
    { code: 504, status: 'DEADLINE_EXCEEDED', message },
    { status: 'DEADLINE_EXCEEDED', message },
    { code: 504, message },
    { code: '408', message },
    { message: 'Provider returned error', metadata: { raw: `{'error': {'code': 504, 'message': '${message}'}}` } }
  ];
  for (const error of errors) {
    assert.equal(await requestsWhenRefused(200, { error }), 1, JSON.stringify(error));
    assert.equal(await requestsWhenStreamSays({ error }), 1, JSON.stringify(error));
  }
});

test('a timeout log in the echoed note cannot suppress a real stream refusal', async () => {
  const note = 'The app logged {"code":"ETIMEDOUT"} during sync.';
  const refusal = { message: 'Unsupported parameter: stream', param: 'stream' };
  for (const report of [
    body => ({ error: refusal, request: body }),
    body => ({ detail: [{ loc: ['body', 'stream'], msg: 'Extra inputs are not permitted', input: body }] }),
    body => ({ error: { message: 'Unsupported parameter: stream. Request: ' + JSON.stringify(body) } }),
    body => ({ error: { metadata: { raw: JSON.stringify({ error: refusal, request: body }) } } })
  ]) {
    const flags = [];
    const { ctx } = runtime(async (_url, options) => {
      const body = JSON.parse(options.body);
      flags.push(!!body.stream);
      return body.stream
        ? jsonResponse(report(body), 400)
        : jsonResponse({ choices: [{ message: { content: 'Recovered' }, finish_reason: 'stop' }] });
    });
    assert.equal((await ctx.callLLMAPI('deepseek', 'm', 'fixture', note, 'en', '', 'summary', '')).text, 'Recovered');
    assert.deepEqual(flags, [true, false]);
  }
});

test('a streaming request mentioned in a validation error does not make its parameter the stream flag', async () => {
  const message = 'Unknown parameter: max_tokens in this streaming request';
  const reports = [
    { error: { param: 'max_tokens', message } },
    { detail: [{ loc: ['body', 'max_tokens'], msg: message }] },
    { error: { message: "Bad request: {'message': '" + message + "', 'param': 'max_tokens'}" } }
  ];
  for (const report of reports) {
    assert.equal(await requestsWhenRefused(400, report), 1);
    assert.equal(await requestsWhenRefused(200, report), 1);
    assert.equal(await requestsWhenStreamSays(report), 1);
  }
});

test('a model refused for "your streaming request" is refused to stream, unless the error names the model as what it rejects', async () => {
  const sentence = 'The model m is not available for your streaming request.';
  const repeated = [
    ['in plain words', 'Model m is not supported for this streaming request'],
    ['the request first', 'Your streaming request is not supported by this model'],
    ['as a message', { error: { message: 'This model does not support the streaming request.' } }],
    ['with a code that names neither', { error: { message: sentence, code: 'unsupported_value' } }],
    ['with the flag as the parameter', { error: { message: sentence, param: 'stream' } }],
    // A sentence that refuses the request itself refuses to stream, whatever the error names.
    [
      'the request refused, with the model in the code',
      { error: { message: 'This model does not support the streaming request.', code: 'model_not_supported' } }
    ],
    [
      'the request refused first, with the model as the parameter',
      { error: { message: 'Your streaming request is not supported by this model', param: 'model' } }
    ],
    [
      'the same in the path of the field',
      { detail: [{ loc: ['body', 'model'], msg: 'The stream call is not allowed for model m' }] }
    ],
    [
      'any streaming request refused, with the model in the code',
      { error: { message: 'Model m is not supported for a streaming request', code: 'model_not_supported' } }
    ]
  ];
  const single = [
    ['the model as the parameter', { error: { message: sentence, param: 'model' } }],
    ['the model in the code', { error: { message: sentence, code: 'model_not_found' } }],
    ['the model in the path of the field', { detail: [{ loc: ['body', 'model'], msg: sentence }] }],
    [
      'the request named as where the model was asked for',
      { error: { message: 'The model named in this stream call is not available', code: 'model_not_found' } }
    ]
  ];
  for (const [what, body] of repeated) assert.equal(await requestsWhenRefused(400, body), 2, what);
  for (const [what, body] of single) assert.equal(await requestsWhenRefused(400, body), 1, what);
});

test('what became of a stream, or of the upstream, is no refusal to stream, in words a refusal has too', async () => {
  const said = message => ({ error: { message } });
  const coded = (code, field = 'code') => ({ error: { message: 'Upstream connection closed', [field]: code } });
  const lost = [
    ['an end that was not expected', said('unexpected end of stream on Connection{upstream:443}')],
    ['the same of what was read from the stream', said('failed to read stream: unexpected EOF')],
    ['an error that is not known', said('An unknown error occurred while streaming')],
    ['an upstream that is unavailable', said('Upstream unavailable: stream disconnected')],
    ['an upstream that is not available', said('Stream closed: upstream is not available')],
    ['the same without a mark between', said('stream failed because upstream is unavailable')],
    [
      'a request that failed with a service unavailable',
      said('The streaming request failed with 503 Service Unavailable')
    ],
    ['a service unavailable while it streamed', said('Service unavailable while streaming the response')],
    ['the stream from upstream as what is not available', said('The upstream stream is not available')],
    ['a connection that is unavailable', said('The streaming connection to the backend is unavailable')],
    ['a stream that brought nothing', said('No stream data received from upstream')],
    ['a stream that was not returned', said('No stream was returned by the upstream')],
    ['a stream that has not been received', said('No stream has been received from the upstream provider')],
    ['a connection closed before output', said('The upstream connection closed without streaming any output')],
    [
      'a provider disconnect identified as such, even when the error names the stream parameter',
      {
        error: {
          code: 502,
          message: 'The upstream connection closed without streaming any output',
          metadata: { error_type: 'provider_disconnected' }
        },
        param: 'stream'
      }
    ],
    [
      'a stream that timed out beside a service that is unavailable',
      said('The stream timed out and the service is unavailable')
    ],
    ['a code for an end that was not expected', coded('unexpected_end_of_stream')],
    ['a code for how the stream ended', coded('stream_ended_unexpectedly')],
    ['a code for a stream that is gone', coded('ERR_HTTP2_INVALID_STREAM')],
    ['a code for a stream without an answer', coded('stream_no_response', 'type')],
    ['an upstream that is unavailable, in Chinese', said('上游服务不可用，流式请求失败')],
    ['the same the other way round, with a space between', said('流式请求失败 上游服务不可用')],
    ['a service that is unavailable for now, in Chinese', said('服务暂不可用，流式连接已断开')],
    ['the stream from upstream as what is unavailable, in Chinese', said('上游流式服务不可用')],
    ['a connection the upstream closed, in Chinese', said('上游已关闭流式连接')]
  ];
  for (const [what, event] of lost) {
    assert.equal(await requestsWhenStreamSays(event), 1, what);
    assert.equal(await requestsWhenRefused(400, event), 1, 'as a refused request: ' + what);
  }
});

test('words a server also has for a failure refuse streaming where they are said of it, or of its flag', async () => {
  const said = message => ({ error: { message } });
  const coded = code => ({ error: { message: 'Bad request', code } });
  const refusals = [
    ['streaming as what is unavailable', said('Streaming is currently unavailable for this model')],
    ['the same with the model named first', said('Streaming for the o1 model is currently unavailable')],
    [
      'the same with more said of the models',
      said('Streaming responses for models in the o-series are not yet available')
    ],
    ['the same with the verb shortened', said("Streaming isn't available on your plan")],
    ['streaming cannot be used', said('Streaming cannot be used with this model')],
    ['the same with the verb shortened', said("Streaming can't be used with this model")],
    ['streaming as what is no longer available', said('Streaming is no longer available for this model')],
    ['streaming named in brackets', said('The requested feature (streaming) is not available for your account')],
    ['the flag written out as what is not available', said('"stream": true is not available for this model')],
    ['streaming as what a model is not available in', said('Model m is not available in streaming mode')],
    ['streaming as the way a model is not available', said('The model m is not available via the streaming API')],
    ['the flag as what a feature is not available with', said('This feature is not available with "stream": true')],
    ['the flag as when a model is not available', said('This model is not available when stream=true')],
    ['the flag as an argument not expected', said("create() got an unexpected keyword argument 'stream'")],
    ['the flag as a field that is not known', said('json: unknown field "stream"')],
    ['the flag as an argument not recognised', said('Unrecognized request argument supplied: stream')],
    [
      'the flag as a name that is not known',
      said('Invalid JSON payload received. Unknown name "stream": Cannot find field.')
    ],
    ['the flag as a key not recognised', said("Unrecognized key(s) in object: 'stream'")],
    ['a code that says it of streaming', coded('streaming_unavailable')],
    ['a code written as one word', coded('StreamingNotSupported')],
    ['a code for streaming as what is not implemented', coded('stream_unimplemented')],
    ['a code for the flag as a parameter that is not valid', coded('invalid_stream_parameter')],
    ['a code for an answer to be asked for in one piece', coded('non_streaming_only')],
    ['streaming as what is unavailable, in Chinese', said('流式输出暂不可用')],
    ['the same with the model named between', said('流式输出功能在当前所选的模型上暂时不可用')],
    ['streaming as what cannot be used, in Chinese', said('该模型无法使用流式输出')],
    ['streaming as what a model cannot be used for, in Chinese', said('该模型不可用于流式调用')],
    ['streaming as what is not offered yet, in Chinese', said('流式输出暂不对外开放')]
  ];
  for (const [what, event] of refusals) {
    assert.equal(await requestsWhenStreamSays(event), 2, what);
    assert.equal(await requestsWhenRefused(400, event), 2, 'as a refused request: ' + what);
  }
});

test('events that arrive together are handed on as text once', async () => {
  const { sent, seen, result } = generation('anthropic');
  const events = streams.anthropic(Array.from({ length: 500 }, () => 'word '));
  sent[0].send(through(events, 'word ').join(''));
  await wait(20);
  assert.deepEqual(seen, ['word '], 'a piece with one delta');
  sent[0].send(events.slice(through(events, 'word ').length).join(''));
  assert.equal((await result).text.length, 2500);
  assert.deepEqual(
    seen.map(text => text.length),
    [5, 2500],
    'and one with all the rest'
  );
});
