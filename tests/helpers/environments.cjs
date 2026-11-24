/** Ready-made contexts for the test files: each loads real scripts over the shared stand-ins. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { root, plain, flush, source, loadScripts, pageScripts } = require('./scripts.cjs');
const { createDom } = require('./dom.cjs');
const { createChrome } = require('./chrome.cjs');
const { createIndexedDB } = require('./indexeddb.cjs');
const { serverFetch, pendingFetch } = require('./http.cjs');

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
    TextDecoder,
    fetch: pendingFetch(requests),
    window: { addEventListener() {} },
    setTimeout() {},
    clearTimeout() {},
    console: { log() {}, error() {}, warn() {} },
    Clipper: { init() {} },
    MemosAPI: { normalizeBaseUrl: value => value && value.replace(/\/+$/, '') + '/' }
  });
  const load = file => {
    loadScripts(context, [file]);
  };
  loadScripts(context, ['http', 'llm-config', 'ai-workflow', 'ai-review', 'llm-transport', 'ai-optimize']);
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
    TextDecoder,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    crypto: webcrypto,
    fetch: fetcher,
    console
  });
  loadScripts(ctx, [
    'http',
    'llm-config',
    'draft-storage',
    'model-catalog',
    'ai-workflow',
    'llm-transport',
    'ai-optimize'
  ]);
  return { ctx, bucket, sync, config: vm.runInContext('LLM_CONFIG', ctx) };
}

/**
 * MemosAPI alone. responder(options) answers each request to an /api/ route (see helpers/http.cjs),
 * `fetcher` answers every other request, such as those for files, and `local` is the local storage the API
 * remembers in.
 */
function loadApi(
  responder = () => {
    throw new Error('Unexpected API request');
  },
  fetcher,
  local = {}
) {
  const calls = [];
  const api = serverFetch(responder, calls);
  const files =
    fetcher ||
    (() => {
      throw new Error('Unexpected file request');
    });
  class TestURL extends URL {}
  const context = vm.createContext({
    chrome: createChrome({ local }),
    URL: TestURL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Blob,
    console: { error() {} },
    fetch: (url, init) => (new URL(url).pathname.includes('/api/') ? api(url, init) : files(url, init))
  });
  loadScripts(context, ['http', 'draft-storage']);
  vm.runInContext(source('memos-api') + '\nglobalThis.api = MemosAPI;', context);
  return { api: context.api, context, calls, local };
}

/**
 * The popup's editor, save flow and search. Sync and local storage are the one `storage` object, and
 * `session` is session storage. The server has no user statistics unless `userTags` is overridden.
 */
async function loadPopup(overrides = {}, saved = {}, session = {}) {
  const { api, context } = loadApi();
  const storage = { ...info, memo_lock: 'PRIVATE', open_action: 'save_text', open_content: 'draft text', ...saved };
  const { $, document, node, handlers, messages, Option } = createDom();
  document.documentElement = { lang: 'en' };
  const chrome = createChrome({
    sync: storage,
    local: storage,
    session,
    onSyncSet: values =>
      assert.ok(!Object.hasOwn(values, 'open_content'), 'draft text must not be written to sync storage')
  });
  chrome.tabs = { query: async () => [] };
  Object.assign(
    api,
    {
      listSpaces: async () => [],
      userTags: async () => null,
      uploadLimit: async () => null,
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
    Option,
    AIReview: { isBusy: () => false, onMemoSaved() {}, refresh() {} },
    window: { addEventListener() {} },
    setTimeout() {},
    indexedDB: createIndexedDB(),
    chrome
  });
  loadScripts(context, [
    'draft-storage',
    'editor-draft',
    'staged-files',
    'memo-tags',
    'memo-index',
    'workspace',
    'oper'
  ]);
  handlers.get('document:DOMContentLoaded')?.();
  await flush();
  return { context, api, node, handlers, messages, storage, session, document };
}

/** The settings page's connection and tag forms over the real MemosAPI; `element(id)` is a page element. */
async function loadSettings(storage = {}, responder) {
  const { context, calls } = loadApi(responder);
  const { $, document, handlers, messages } = createDom();
  Object.assign(context, { $, document, chrome: createChrome({ sync: storage }), uiMessage: key => key });
  loadScripts(context, ['draft-storage', 'memo-tags', 'settings']);
  handlers.get('document:DOMContentLoaded')();
  await flush();
  return { context, element: id => document.getElementById(id), calls, storage, messages };
}

/** The one FileReader method the extension calls. */
class FileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      bytes => {
        this.result = 'data:' + blob.type + ';base64,' + Buffer.from(bytes).toString('base64');
        this.onload();
      },
      error => {
        this.error = error;
        this.onerror();
      }
    );
  }
}

/** StagedFiles over an in-memory indexedDB and the real MemosAPI; `files` is the map behind its store. */
function loadStagedFiles({ responder, fetcher, sync = {}, local = {} } = {}) {
  const { context, calls } = loadApi(responder, fetcher);
  const files = new Map();
  Object.assign(context, {
    chrome: createChrome({ sync, local }),
    indexedDB: createIndexedDB(new Map([['ai-memos-files/files', files]])),
    crypto: webcrypto,
    FileReader
  });
  loadScripts(context, ['draft-storage', 'staged-files']);
  return { context, staged: context.StagedFiles, files, calls, sync, local };
}

/** What a page and the service worker both have from the browser. */
function hostGlobals(storage) {
  const chrome = createChrome(storage);
  const event = { addListener() {} };
  Object.assign(chrome.runtime, { id: 'extension', getURL: file => 'chrome-extension://extension/' + file });
  Object.assign(chrome.runtime, { onInstalled: event, onMessage: event, openOptionsPage() {} });
  chrome.i18n.getUILanguage = () => 'en';
  chrome.tabs = { query: async () => [], get: async () => ({}), create() {} };
  chrome.contextMenus = { removeAll() {}, create() {}, onClicked: event };
  return {
    chrome,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Blob,
    TextEncoder,
    crypto: webcrypto,
    indexedDB: createIndexedDB(),
    fetch: async () => {
      throw new Error('Unexpected request');
    },
    setTimeout() {},
    console: { log() {}, error() {}, warn() {} }
  };
}

/** Runs one script of js/ in the context; an error it throws while loading names the script. */
function runScript(context, script) {
  try {
    loadScripts(context, [script]);
  } catch (error) {
    throw new Error(script + ' failed while loading: ' + error.message, { cause: error });
  }
}

const libraries = ['js/jquery.min.js', 'js/view-image.js'];

/**
 * Runs a page's own scripts in the order its HTML lists them, in one context, up to the point where the
 * browser would fire DOMContentLoaded. `$` and `ViewImage` are stand-ins, present from the place where
 * the page includes the library; `scripts` are the own scripts that ran, as paths.
 */
function loadPage(page) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const listed = pageScripts(page);
  const { $, document, Option } = createDom();
  $.extend = extra => Object.assign($, extra);
  delete $.message; // js/message.js adds it
  const dataset = Object.fromEntries(
    Array.from(html.match(/<html\b[^>]*>/)[0].matchAll(/\bdata-([a-z]+)="([^"]*)"/g), hit => [hit[1], hit[2]])
  );
  document.documentElement = { lang: 'en', dataset };
  const context = vm.createContext({
    ...hostGlobals(),
    document,
    location: { search: '', protocol: 'chrome-extension:', replace() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    Option,
    FileReader
  });
  context.window = context;
  const scripts = listed.filter(script => !libraries.includes(script));
  for (const script of listed) {
    // A library exists only from its own place in the page onwards, as in a browser.
    if (script === 'js/jquery.min.js') context.$ = $;
    else if (script === 'js/view-image.js') context.ViewImage = { init() {} };
    else runScript(context, script.replace(/^js\//, ''));
  }
  return { context, scripts };
}

/**
 * CaptureService as the service worker runs it, over an in-memory indexedDB. The injected page script
 * answers with `page`, and `fetcher` answers each image request; `files` is the map behind the file store.
 */
function loadCapture({ page, fetcher, sync = {}, local = {} } = {}) {
  const files = new Map();
  const globals = hostGlobals({ sync, local });
  globals.chrome.scripting = { executeScript: async ({ func }) => (func ? [{ result: page }] : []) };
  const context = vm.createContext({
    ...globals,
    indexedDB: createIndexedDB(new Map([['ai-memos-files/files', files]])),
    fetch: fetcher
  });
  loadScripts(context, ['draft-storage', 'clipper-core', 'staged-files', 'capture-service']);
  return { context, capture: context.CaptureService, files, sync, local };
}

/** Runs the service worker; importScripts loads the files it names into the same context. */
function loadWorker() {
  const scripts = ['js/background.js'];
  const context = vm.createContext({
    ...hostGlobals(),
    importScripts(...names) {
      for (const name of names) {
        scripts.push('js/' + name);
        runScript(context, name);
      }
    }
  });
  runScript(context, 'background.js');
  return { context, scripts };
}

module.exports = {
  info,
  harness,
  loadRules,
  runtime,
  loadApi,
  loadPopup,
  loadSettings,
  loadStagedFiles,
  loadCapture,
  loadPage,
  loadWorker
};
