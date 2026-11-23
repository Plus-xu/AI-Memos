/** Ready-made contexts for the test files: each loads real scripts over the shared stand-ins. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { plain, flush, source, loadScripts } = require('./scripts.cjs');
const { createDom } = require('./dom.cjs');
const { createChrome } = require('./chrome.cjs');

const info = { apiUrl: 'https://memos.example/', apiTokens: 'test-pat', userName: 'users/tester' };

/** The popup's AI surface: model settings, the review panel and the task runner, with requests recorded. */
function harness(options = {}) {
  const local = plain(options.local || {});
  const sync = {
    apiUrl: 'https://memos.example/',
    apiTokens: 'memos-test-pat',
    memo_lock: 'PRIVATE',
    llmActiveProvider: 'openai',
    llmProviderConfigs: { openai: { model: 'gpt-5.5', apiKey: 'ai-test-key', baseUrl: '' } },
    ...(options.sync || {})
  };
  const { $, document, node, handlers, messages, inputChanges } = createDom();
  const requests = [];
  $.ajax = value => {
    requests.push(value);
    return {};
  };
  const chrome = createChrome({
    sync,
    local,
    messages: key => (['aiRunTask', 'aiRunningTask', 'aiExecutedTask'].includes(key) ? key + ': {task}' : key)
  });
  chrome.i18n.getUILanguage = () => 'zh-CN';
  const context = vm.createContext({
    $,
    chrome,
    document,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Blob,
    window: { addEventListener() {} },
    setTimeout() {},
    console: { log() {}, error() {}, warn() {} },
    Clipper: { init() {} },
    MemosAPI: { normalizeBaseUrl: value => value && value.replace(/\/+$/, '') + '/' }
  });
  const load = file => {
    loadScripts(context, [file]);
  };
  loadScripts(context, ['llm-config', 'ai-workflow', 'ai-review', 'ai-optimize']);
  node('#content').val(options.content === undefined ? 'Original draft' : options.content);
  node('#aiTask').val('organize');
  node('#llmProvider').val('openai');
  node('#llmModel').val('gpt-5.5');
  node('#llmApiKey').val('ai-test-key');
  context.loadLLMState(() => {});
  context.AIReview.init();
  return { context, node, handlers, local, sync, messages, requests, inputChanges, load };
}

/** The pure rule modules, with no browser APIs at all. */
function loadRules() {
  const context = loadScripts(vm.createContext({ URL }), ['ai-workflow', 'clipper-core']);
  return { ai: context.AIWorkflow, clipper: context.ClipperCore };
}

/** Provider transports and the model catalog over a caller-supplied fetch, with no page elements. */
function runtime(fetcher) {
  const bucket = {},
    sync = {};
  const ctx = vm.createContext({
    document: {},
    $: () => ({ ready() {} }),
    chrome: createChrome({ sync, local: bucket }),
    URL,
    URLSearchParams,
    TextEncoder,
    AbortSignal,
    crypto: webcrypto,
    fetch: fetcher,
    console
  });
  loadScripts(ctx, ['llm-config', 'draft-storage', 'model-catalog', 'ai-workflow', 'ai-optimize']);
  return { ctx, bucket, sync, config: vm.runInContext('LLM_CONFIG', ctx) };
}

/** MemosAPI alone; responder answers each $.ajax call. */
function loadApi(
  responder = () => {
    throw new Error('Unexpected API request');
  },
  fetcher
) {
  const calls = [];
  class TestURL extends URL {}
  const context = vm.createContext({
    URL: TestURL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Blob,
    console: { error() {} },
    fetch:
      fetcher ||
      (() => {
        throw new Error('Unexpected file request');
      }),
    $: {
      ajax(options) {
        calls.push(options);
        return Promise.resolve().then(() => responder(options));
      }
    }
  });
  vm.runInContext(source('memos-api') + '\nglobalThis.api = MemosAPI;', context);
  return { api: context.api, context, calls };
}

/** The popup's editor, save flow and search. Sync and local storage are the one `storage` object. */
async function loadPopup(overrides = {}, saved = {}) {
  const { api, context } = loadApi();
  const storage = { ...info, memo_lock: 'PRIVATE', open_action: 'save_text', open_content: 'draft text', ...saved };
  const { $, document, node, handlers, messages } = createDom();
  document.documentElement = { lang: 'en' };
  const chrome = createChrome({
    sync: storage,
    local: storage,
    onSyncSet: values =>
      assert.ok(!Object.hasOwn(values, 'open_content'), 'draft text must not be written to sync storage')
  });
  chrome.tabs = { query: async () => [] };
  Object.assign(
    api,
    {
      listSpaces: async () => [],
      getInstanceProfile: async () => ({ version: '0.31.0' }),
      prepareMemo: async (_, body) => body,
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body }),
      getMemo: async () => ({ name: 'memos/saved', content: 'saved' })
    },
    overrides
  );
  Object.assign(context, {
    $,
    MemosAPI: api,
    document,
    crypto: webcrypto,
    TextEncoder,
    uiMessage: key => key,
    Option: class {},
    AIReview: { isBusy: () => false, onMemoSaved() {}, refresh() {} },
    window: { addEventListener() {} },
    setTimeout() {},
    chrome
  });
  loadScripts(context, ['draft-storage', 'editor-draft', 'staged-files', 'memo-tags', 'workspace', 'oper']);
  handlers.get('document:DOMContentLoaded')?.();
  await flush();
  return { context, api, node, handlers, messages, storage, document };
}

module.exports = { info, harness, loadRules, runtime, loadApi, loadPopup };
