/** The stand-in environments of the test files, moved here unchanged. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { root, plain, flush } = require('./scripts.cjs');

const info = { apiUrl: 'https://memos.example/', apiTokens: 'test-pat', userName: 'users/tester' };

function harness(options = {}) {
  const nodes = new Map();
  const elementNodes = new WeakMap();
  const handlers = new Map();
  const local = plain(options.local || {});
  const sync = {
    apiUrl: 'https://memos.example/',
    apiTokens: 'memos-test-pat',
    memo_lock: 'PRIVATE',
    llmActiveProvider: 'openai',
    llmProviderConfigs: { openai: { model: 'gpt-5.5', apiKey: 'ai-test-key', baseUrl: '' } },
    ...(options.sync || {})
  };
  const messages = [];
  const requests = [];
  const inputChanges = [];
  const document = {
    querySelectorAll: () => [],
    addEventListener() {},
    getElementById: id => node('#' + id)[0]
  };

  function node(selector) {
    if (selector === 'textarea[name=text]') selector = '#content';
    if (nodes.has(selector)) return nodes.get(selector);
    const element = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      focus() {},
      setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      }
    };
    const wrapper = {
      0: element,
      length: selector.startsWith('.') ? 0 : 1,
      attributes: {},
      properties: {},
      val(value) {
        if (value === undefined) return element.value;
        element.value = value;
        return this;
      },
      text(value) {
        if (value === undefined) return this.textValue || '';
        this.textValue = value;
        return this;
      },
      html(value) {
        if (value === undefined) return this.htmlValue || '';
        this.htmlValue = value;
        return this;
      },
      attr(key, value) {
        if (value === undefined) return this.attributes[key];
        this.attributes[key] = value;
        return this;
      },
      removeAttr(key) {
        delete this.attributes[key];
        return this;
      },
      prop(key, value) {
        if (value === undefined) return this.properties[key];
        this.properties[key] = value;
        element[key] = value;
        return this;
      },
      is(query) {
        return query === ':checked' && !!this.properties.checked;
      },
      data(key) {
        return this.attributes['data-' + key];
      },
      on(events, delegated, callback) {
        const fn = callback || delegated;
        for (const event of events.split(' ')) {
          const key = selector + ':' + event + (typeof delegated === 'string' ? ':' + delegated : '');
          const list = handlers.get(key) || [];
          list.push(fn);
          handlers.set(key, list);
        }
        return this;
      },
      click(callback) {
        return callback ? this.on('click', callback) : this.trigger('click');
      },
      change(callback) {
        return this.on('change', callback);
      },
      blur(callback) {
        return this.on('blur', callback);
      },
      trigger(event) {
        const value = { target: element, preventDefault() {} };
        for (const callback of handlers.get(selector + ':' + event) || []) callback.call(element, value);
        if (selector === '#content' && event === 'input') inputChanges.push(element.value);
        return this;
      },
      ready(callback) {
        this.readyCallback = callback;
        return this;
      },
      each() {
        return this;
      },
      find(child) {
        return node(selector + ' ' + child);
      }
    };
    for (const method of [
      'hide',
      'show',
      'slideDown',
      'slideToggle',
      'toggleClass',
      'addClass',
      'removeClass',
      'css',
      'focus',
      'toggle',
      'empty',
      'append'
    ]) {
      wrapper[method] = function () {
        return this;
      };
    }
    nodes.set(selector, wrapper);
    elementNodes.set(element, wrapper);
    return wrapper;
  }

  function $(selector) {
    if (selector === document) return node('document');
    if (selector && typeof selector === 'object' && elementNodes.has(selector)) return elementNodes.get(selector);
    return node(selector);
  }
  $.message = value => messages.push(value.message);
  $.ajax = value => {
    requests.push(value);
    return {};
  };
  $.each = (items, callback) => items.forEach((item, index) => callback(index, item));

  function read(store, keys) {
    if (Array.isArray(keys))
      return Object.fromEntries(keys.filter(key => Object.hasOwn(store, key)).map(key => [key, plain(store[key])]));
    return plain({
      ...keys,
      ...Object.fromEntries(
        Object.keys(keys)
          .filter(key => Object.hasOwn(store, key))
          .map(key => [key, store[key]])
      )
    });
  }

  const chrome = {
    runtime: { lastError: null },
    i18n: {
      getMessage: key => (['aiRunTask', 'aiRunningTask', 'aiExecutedTask'].includes(key) ? key + ': {task}' : key),
      getUILanguage: () => 'zh-CN'
    },
    storage: {
      local: {
        get(keys, callback) {
          callback(read(local, keys));
        },
        set(value, callback) {
          Object.assign(local, plain(value));
          callback?.();
        }
      },
      sync: {
        get(keys, callback) {
          callback(read(sync, keys));
        },
        set(value, callback) {
          Object.assign(sync, plain(value));
          callback?.();
        }
      }
    }
  };
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
  function load(file) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), context, { filename: file });
  }
  for (const file of ['llm-config.js', 'ai-workflow.js', 'ai-review.js', 'ai-optimize.js']) load(file);
  node('#content').val(options.content === undefined ? 'Original draft' : options.content);
  node('#aiTask').val('organize');
  node('#llmProvider').val('openai');
  node('#llmModel').val('gpt-5.5');
  node('#llmApiKey').val('ai-test-key');
  context.loadLLMState(() => {});
  context.AIReview.init();
  return { context, node, handlers, local, sync, messages, requests, inputChanges, load };
}

function loadRules() {
  const context = vm.createContext({ URL });
  for (const file of ['ai-workflow.js', 'clipper-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), context, { filename: file });
  }
  return { ai: context.AIWorkflow, clipper: context.ClipperCore };
}

function runtime(fetcher) {
  const bucket = {},
    sync = {},
    document = {};
  function store(data) {
    return {
      get: (defaults, callback) => callback({ ...defaults, ...structuredClone(data) }),
      set: (fields, callback) => {
        Object.assign(data, structuredClone(fields));
        callback();
      }
    };
  }
  const $ = () => ({ ready() {} });
  const chrome = {
    runtime: {},
    i18n: { getMessage: key => key },
    storage: { local: store(bucket), sync: store(sync) }
  };
  const ctx = vm.createContext({
    document,
    $,
    chrome,
    URL,
    URLSearchParams,
    TextEncoder,
    AbortSignal,
    crypto: webcrypto,
    fetch: fetcher,
    console
  });
  for (const file of ['llm-config', 'draft-storage', 'model-catalog', 'ai-workflow', 'ai-optimize']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file + '.js'), 'utf8'), ctx, { filename: file });
  }
  return { ctx, bucket, sync, config: vm.runInContext('LLM_CONFIG', ctx) };
}

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
  vm.runInContext(
    fs.readFileSync(path.join(root, 'js/memos-api.js'), 'utf8') + '\nglobalThis.api = MemosAPI;',
    context
  );
  return { api: context.api, context, calls };
}

async function loadPopup(overrides = {}, saved = {}) {
  const { api, context } = loadApi();
  const nodes = new Map();
  const handlers = new Map();
  const messages = [];
  const storage = { ...info, memo_lock: 'PRIVATE', open_action: 'save_text', open_content: 'draft text', ...saved };
  const ready = [];
  const document = {
    documentElement: { lang: 'en' },
    addEventListener(event, fn) {
      if (event === 'DOMContentLoaded') ready.push(fn);
    },
    querySelectorAll: () => [],
    getElementById: id => node('#' + id)[0]
  };
  function node(selector) {
    if (selector === 'textarea[name=text]') selector = '#content';
    if (nodes.has(selector)) return nodes.get(selector);
    const element = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      focus() {},
      replaceChildren() {},
      add() {},
      setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      }
    };
    const wrapper = {
      0: element,
      attributes: {},
      properties: {},
      val(value) {
        if (value === undefined) return element.value;
        element.value = value;
        return this;
      },
      text(value) {
        if (value === undefined) return this.textValue || '';
        this.textValue = value;
        return this;
      },
      html(value) {
        this.htmlValue = value;
        return this;
      },
      attr(key, value) {
        if (value === undefined) return this.attributes[key];
        this.attributes[key] = value;
        return this;
      },
      removeAttr(key) {
        delete this.attributes[key];
        return this;
      },
      prop(key, value) {
        if (value === undefined) return this.properties[key];
        this.properties[key] = value;
        element[key] = value;
        return this;
      },
      on(event, delegated, fn) {
        handlers.set(selector + ':' + event + (typeof delegated === 'string' ? ':' + delegated : ''), fn || delegated);
        return this;
      },
      click(fn) {
        if (fn) handlers.set(selector + ':click', fn);
        else handlers.get(selector + ':click')?.();
        return this;
      },
      blur(fn) {
        handlers.set(selector + ':blur', fn);
        return this;
      }
    };
    for (const method of ['hide', 'show', 'slideDown', 'slideToggle', 'toggleClass', 'css', 'focus'])
      wrapper[method] = function () {
        return this;
      };
    nodes.set(selector, wrapper);
    return wrapper;
  }
  function $(selector) {
    return node(selector === document ? 'document' : selector);
  }
  $.message = message => messages.push(message.message);
  $.each = (values, callback) => values.forEach((value, index) => callback(index, value));
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
    crypto: require('node:crypto').webcrypto,
    TextEncoder,
    uiMessage: key => key,
    Option: class {},
    AIReview: { isBusy: () => false, onMemoSaved() {}, refresh() {} },
    window: { addEventListener() {} },
    setTimeout() {},
    chrome: {
      runtime: { lastError: null },
      i18n: { getMessage: key => key },
      tabs: { query: async () => [] },
      storage: {
        onChanged: { addListener() {} },
        sync: {
          get(defaults, callback) {
            callback({ ...defaults, ...storage });
          },
          set(values, callback) {
            assert.ok(!Object.hasOwn(values, 'open_content'), 'draft text must not be written to sync storage');
            Object.assign(storage, plain(values));
            callback?.();
          }
        },
        local: {
          get(defaults, callback) {
            callback({
              ...defaults,
              ...Object.fromEntries(
                Object.keys(defaults)
                  .filter(key => Object.hasOwn(storage, key))
                  .map(key => [key, storage[key]])
              )
            });
          },
          set(values, callback) {
            Object.assign(storage, plain(values));
            callback?.();
          }
        }
      }
    }
  });
  for (const file of ['draft-storage', 'editor-draft', 'staged-files', 'memo-tags', 'workspace'])
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file + '.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/oper.js'), 'utf8'), context);
  ready.forEach(fn => fn());
  await flush();
  return { context, api, node, handlers, messages, storage, document };
}

module.exports = { info, harness, loadRules, runtime, loadApi, loadPopup };
