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
    ['anthropic', sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error')]
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
    'Overloaded'
  ]);
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
