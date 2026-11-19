const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

function runtime(fetcher) {
  const bucket = {}, sync = {}, document = {};
  function store(data) {
    return { get: (defaults, callback) => callback({ ...defaults, ...structuredClone(data) }),
      set: (fields, callback) => { Object.assign(data, structuredClone(fields)); callback(); } };
  }
  const $ = () => ({ ready() {} });
  const chrome = { runtime:{}, i18n:{ getMessage: key => key }, storage:{ local:store(bucket), sync:store(sync) } };
  const ctx = vm.createContext({ document, $, chrome, URL, URLSearchParams, TextEncoder, AbortSignal,
    crypto:webcrypto, fetch:fetcher, console });
  for (const file of ['llm-config','draft-storage','model-catalog','ai-workflow','ai-optimize']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../js/' + file + '.js'), 'utf8'), ctx, { filename:file });
  }
  return { ctx, bucket, sync, config: vm.runInContext('LLM_CONFIG',ctx) };
}

const transports = [
  ['openai','gpt-6.2-sol','/v1/responses','Authorization','max_output_tokens',{ output:[{ type:'message',content:[{ type:'output_text',text:'answer' }] }] }],
  ['anthropic','claude-sonnet-5-5','/v1/messages','x-api-key','max_tokens',{ content:[{ type:'thinking',thinking:'omit' },{ type:'text',text:'answer' }] }],
  ['gemini','gemini-4-hydrogen','/v1beta/models/gemini-4-hydrogen:generateContent','x-goog-api-key',null,{ candidates:[{ content:{ parts:[{ thought:true,text:'omit' },{ text:'answer' }] } }] }],
  ['deepseek','deepseek-flash','/v1/chat/completions','Authorization','max_tokens',{ choices:[{ message:{ reasoning_content:'omit',content:'answer' } }] }],
  ['newapi','custom-channel','/gateway/v1/chat/completions','Authorization',null,{ choices:[{ message:{ content:[{ type:'text',text:'answer' }] } }] }]
];
for (const [provider,model,route,header,limit,response] of transports) {
  test(provider + ' sends the selected model using its text protocol and extracts visible text', async () => {
    const { ctx,config } = runtime();
    if (provider !== 'newapi') assert.equal(config.providers[provider].models[0].value,model);
    let request;
    ctx.$.ajax = value => { request = value; value.success(response); };
    assert.equal(await ctx.callLLMAPI(provider,model,'fixture-key','Plain note','en','https://fixture.test/gateway/v1/','summary',''),'answer');
    const body = JSON.parse(request.data), url = new URL(request.url);
    assert.equal(url.pathname,route);
    assert.equal(url.search,'');
    assert.equal(request.headers[header], header === 'Authorization' ? 'Bearer fixture-key' : 'fixture-key');
    assert.equal(JSON.stringify(body).includes('fixture-key'),false);
    assert.equal(JSON.stringify(body).includes('temperature'),false);
    if (limit) assert.ok(body[limit] > 0);
    if (provider === 'gemini') assert.ok(body.generationConfig.maxOutputTokens > 0);
    else assert.equal(body.model,model);
  });
}

test('generation errors distinguish permissions, rate limits, interrupted requests, empty and truncated responses', async () => {
  const { ctx } = runtime();
  const request = () => ctx.callLLMAPI('openai','gpt-6.2-sol','key','note','en','','summary','');
  for (const [status,expected] of [[0,'aiInterrupted'],[401,'aiUnavailable'],[403,'aiUnavailable'],[429,'requestLimited']]) {
    ctx.$.ajax = options => options.error({ status });
    await assert.rejects(request(), new RegExp(expected));
  }
  for (const [response,expected] of [[{ output_text:'  ' },'aiEmpty'],[{ status:'incomplete',output_text:'partial' },'aiTruncated']]) {
    ctx.$.ajax = options => options.success(response);
    await assert.rejects(request(), new RegExp(expected));
  }
});

test('model list pagination filters modalities, refuses repeated cursors and retains cached names after a failed refresh', async () => {
  const calls = [];
  let mode = 'ok';
  const {ctx,bucket} = runtime(async (url, options) => {
    assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
    assert.equal(options.headers['x-goog-api-key'],'fixture-key');
    calls.push(String(url));
    if (mode === 'denied') return new Response('{}',{ status:403 });
    const models = [{ name:'models/text-a',supportedGenerationMethods:['generateContent'] },
      { name:'models/embedding-001',supportedGenerationMethods:['embedContent'] },
      { name:'models/gemini-image-4',supportedGenerationMethods:['generateContent'] }];
    if (url.searchParams.has('pageToken')) models.push({ name:'models/text-b',supportedGenerationMethods:['generateContent'] });
    return Response.json({ models,nextPageToken: !url.searchParams.has('pageToken') || mode === 'repeat' ? '+/opaque' : undefined });
  });
  const c = ctx.ModelCatalog, key = { apiKey:'fixture-key' };
  assert.equal(await c.refresh('gemini',key),2);
  assert.deepEqual(Array.from(c.list('gemini')),['text-a','text-b']);
  assert.equal(new URL(calls[1]).searchParams.get('pageToken'),'+/opaque');
  assert.doesNotMatch(JSON.stringify(bucket),/fixture-key|googleapis/);
  mode = 'denied'; await assert.rejects(c.refresh('gemini',key), e => e.status === 403);
  mode = 'repeat'; await assert.rejects(c.refresh('gemini',key),/modelInvalid/);
  assert.deepEqual(Array.from(c.list('gemini')),['text-a','text-b']);
  await c.restore('gemini',{apiKey:'changed'}); assert.deepEqual(Array.from(c.list('gemini')),[]);
  await c.restore('gemini',key); assert.equal(c.list('gemini').length,2);
});

test('Anthropic discovery advances after_id and New API isolates catalogs by URL and token', async () => {
  const urls = [];
  const {ctx} = runtime(async (url,options) => {
    urls.push(String(url));
    if (url.hostname.includes('anthropic')) {
      assert.equal(options.headers['anthropic-version'],'2023-06-01');
      return Response.json({ data:[{id:url.search ? 'two':'one'}],has_more:!url.search,last_id:'one' });
    }
    assert.match(options.headers.Authorization,/^Bearer /);
    return Response.json({data:[{id:'alpha'},{id:'text-embedding-3-small'}]});
  });
  const c = ctx.ModelCatalog;
  assert.equal(await c.refresh('anthropic',{apiKey:'a'}),2);
  assert.equal(new URL(urls[1]).searchParams.get('after_id'),'one');
  assert.equal(await c.refresh('newapi',{apiKey:'a',baseUrl:'https://gateway.test'}),1);
  assert.match(urls.at(-1),/gateway\.test\/v1\/models$/);
  await c.restore('newapi',{apiKey:'a',baseUrl:'https://other.test'}); assert.equal(c.list('newapi').length,0);
  await c.restore('newapi',{apiKey:'a',baseUrl:'https://gateway.test/v1/'}); assert.equal(c.list('newapi').length,1);
  for (const url of ['file:///tmp','https://user@host.test/', 'https://host.test/?access=1']) assert.throws(()=>c.gateway(url),/modelGatewayUrl/);
});

test('edits merge at separate positions and overlapping edits leave the stored revision intact', async () => {
  const {ctx} = runtime(); const draft = ctx.DraftStorage;
  const base = await draft.append('A B C');
  const left = await draft.commit(base,'Alpha B C');
  const both = await draft.commit(base,'A B Charlie');
  assert.equal(both.open_content,'Alpha B Charlie'); assert.ok(both.revision > left.revision);
  await assert.rejects(draft.commit(left,'Alpha B Coda'), error => error.latest.open_content === both.open_content);
  assert.equal((await draft.current()).revision,both.revision);
  await draft.append('later clip');
  assert.equal((await draft.finish(both)).open_content,'later clip');
});

test('clip history is created per account, contains only source metadata and keeps a single receipt on retry', async () => {
  const {ctx,bucket} = runtime(); const ds = ctx.DraftStorage;
  const info = {apiUrl:'https://memos.test/',userName:'users/a',apiTokens:'private-token'};
  const source = {url:'https://source.test/note',title:'A'};
  const memo = {name:'memos/id',content:'private body'};
  assert.equal((await ds.history(info)).length,0);
  await ds.record(info,memo,[source]); await ds.record(info,memo,[source]);
  assert.equal((await ds.history(info)).length,1);
  assert.equal((await ds.history({...info,userName:'users/b'})).length,0);
  assert.doesNotMatch(JSON.stringify(bucket),/private-token|private body/);
});

test('AI review detects lost staged attachments and preserves a legacy DeepSeek alias as selected', () => {
  const {ctx} = runtime();
  const ref = 'memos-local://d25d813a-bfc9-45e4-90ac-33a255e98496';
  const review = ctx.AIWorkflow.review('![photo](' + ref + ')','text','summary');
  assert.deepEqual(Array.from(ctx.AIWorkflow.missingReferences(review)),[ref]);
  const legacy = ctx.normalizeProviderConfig('deepseek',{model:'deepseek-v4-flash',apiKey:'test'});
  assert.equal(legacy.model,'deepseek-v4-flash');
});
