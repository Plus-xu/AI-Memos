const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const nodes = new Map();
  const elementNodes = new WeakMap();
  const handlers = new Map();
  const local = plain(options.local || {});
  const sync = {
    apiUrl: 'https://memos.example/', apiTokens: 'memos-test-pat', memo_lock: 'PRIVATE',
    llmActiveProvider: 'openai',
    llmProviderConfigs: { openai: { model: 'gpt-5.5', apiKey: 'ai-test-key', baseUrl: '' } },
    ...(options.sync || {})
  };
  const messages = [];
  const requests = [];
  const inputChanges = [];
  const document = {
    querySelectorAll: () => [], addEventListener() {},
    getElementById: id => node('#' + id)[0]
  };

  function node(selector) {
    if (selector === 'textarea[name=text]') selector = '#content';
    if (nodes.has(selector)) return nodes.get(selector);
    const element = {
      value: '', selectionStart: 0, selectionEnd: 0, focus() {},
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    };
    const wrapper = {
      0: element, length: selector.startsWith('.') ? 0 : 1, attributes: {}, properties: {},
      val(value) { if (value === undefined) return element.value; element.value = value; return this; },
      text(value) { if (value === undefined) return this.textValue || ''; this.textValue = value; return this; },
      html(value) { if (value === undefined) return this.htmlValue || ''; this.htmlValue = value; return this; },
      attr(key, value) { if (value === undefined) return this.attributes[key]; this.attributes[key] = value; return this; },
      removeAttr(key) { delete this.attributes[key]; return this; },
      prop(key, value) {
        if (value === undefined) return this.properties[key];
        this.properties[key] = value; element[key] = value; return this;
      },
      is(query) { return query === ':checked' && !!this.properties.checked; },
      data(key) { return this.attributes['data-' + key]; },
      on(events, delegated, callback) {
        const fn = callback || delegated;
        for (const event of events.split(' ')) {
          const key = selector + ':' + event + (typeof delegated === 'string' ? ':' + delegated : '');
          const list = handlers.get(key) || [];
          list.push(fn); handlers.set(key, list);
        }
        return this;
      },
      click(callback) { return callback ? this.on('click', callback) : this.trigger('click'); },
      change(callback) { return this.on('change', callback); },
      blur(callback) { return this.on('blur', callback); },
      trigger(event) {
        const value = { target: element, preventDefault() {} };
        for (const callback of handlers.get(selector + ':' + event) || []) callback.call(element, value);
        if (selector === '#content' && event === 'input') inputChanges.push(element.value);
        return this;
      },
      ready(callback) { this.readyCallback = callback; return this; },
      each() { return this; },
      find(child) { return node(selector + ' ' + child); }
    };
    for (const method of ['hide', 'show', 'slideDown', 'slideToggle', 'toggleClass', 'addClass', 'removeClass', 'css', 'focus', 'toggle', 'empty', 'append']) {
      wrapper[method] = function () { return this; };
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
  $.ajax = value => { requests.push(value); return {}; };
  $.each = (items, callback) => items.forEach((item, index) => callback(index, item));

  function read(store, keys) {
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => Object.hasOwn(store, key)).map(key => [key, plain(store[key])]));
    return plain({ ...keys, ...Object.fromEntries(Object.keys(keys).filter(key => Object.hasOwn(store, key)).map(key => [key, store[key]])) });
  }

  const chrome = {
    runtime: { lastError: null },
    i18n: {
      getMessage: key => ['aiRunTask', 'aiRunningTask', 'aiExecutedTask'].includes(key) ? key + ': {task}' : key,
      getUILanguage: () => 'zh-CN'
    },
    storage: {
      local: { get(keys, callback) { callback(read(local, keys)); }, set(value, callback) { Object.assign(local, plain(value)); callback?.(); } },
      sync: { get(keys, callback) { callback(read(sync, keys)); }, set(value, callback) { Object.assign(sync, plain(value)); callback?.(); } }
    }
  };
  const dayjs = () => ({ fromNow: () => 'now' });
  dayjs.extend = dayjs.locale = () => {};
  const context = vm.createContext({
    $, chrome, document, URL, URLSearchParams, AbortController, AbortSignal, Blob, dayjs,
    window: { addEventListener() {} }, setTimeout() {},
    console: { log() {}, error() {}, warn() {} },
    Clipper: { init() {} },
    MemosAPI: { normalizeBaseUrl: value => value && value.replace(/\/+$/, '') + '/' }
  });
  function load(file) { vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), context, { filename: file }); }
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

test('AI results are persisted as a pending review without replacing the draft', () => {
  const state = harness();
  state.context.AIReview.show('Original draft', 'Rewritten result', 'summary');
  assert.equal(state.node('#content').val(), 'Original draft');
  assert.equal(state.node('#aiReviewOriginal').val(), 'Original draft');
  assert.equal(state.node('#aiReviewResult').val(), 'Rewritten result');
  assert.equal(state.node('#aiReviewPanel').prop('hidden'), false);
  assert.equal(state.local.memosAIReview.input, 'Original draft');
  assert.equal(state.local.memosAIReview.result, 'Rewritten result');
  assert.deepEqual(state.inputChanges, []);
  state.node('#aiReviewDiscard').click();
  assert.equal(state.node('#content').val(), 'Original draft');
  assert.equal(state.node('#aiReviewPanel').prop('hidden'), true);
  assert.equal(state.local.memosAIReview, null);
});

test('an empty edited AI result disables adoption and cannot change the draft', () => {
  const state = harness();
  state.context.AIReview.show('Original draft', 'Initial result', 'summary');
  state.node('#aiReviewResult').val('   ').trigger('input');
  assert.equal(state.node('#aiReviewReplace').prop('disabled'), true);
  assert.equal(state.node('#aiReviewAppend').prop('disabled'), true);
  state.node('#aiReviewReplace').click();
  state.node('#aiReviewAppend').click();
  assert.equal(state.node('#content').val(), 'Original draft');
});

test('adding a page source uses only existing tabs access and preserves the draft on unsupported URLs', () => {
  const state = harness();
  state.load('clipper-core.js');
  state.load('clipper.js');
  let url = 'https://example.org/read(1)?id=2';
  state.context.chrome.tabs = { query(_, callback) { callback([{ title: 'An [article]', url }]); } };
  state.node('#content')[0].setSelectionRange('Original draft'.length, 'Original draft'.length);
  state.context.Clipper.addPageSource();
  assert.match(state.node('#content').val(), /^Original draft\s*\[An \\\[article\\\]\]\(https:\/\/example\.org\/read%281%29\?id=2\)/);
  const before = state.node('#content').val();
  url = 'chrome://extensions/';
  state.context.Clipper.addPageSource();
  assert.equal(state.node('#content').val(), before);
  assert.equal(state.messages.at(-1), 'clipCaptureFailed');
});

test('the consolidated source action replaces only the selected range and omits time by default', () => {
  const state = harness({ content: 'Before OLD after' });
  state.load('clipper-core.js');
  state.load('clipper.js');
  state.context.chrome.tabs = { query(_, callback) { callback([{ title: 'Article', url: 'https://example.org/article?id=7' }]); } };
  state.context.Clipper.init();
  state.node('#content')[0].setSelectionRange(7, 10);
  state.context.Clipper.addPageSource();
  const value = state.node('#content').val();
  assert.ok(value.startsWith('Before '));
  assert.ok(value.endsWith(' after'));
  assert.ok(value.includes('[Article](https://example.org/article?id=7)'));
  assert.ok(!value.includes('OLD'));
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(value));
  assert.equal(state.node('#sourceIncludeTime').prop('checked'), false);
  assert.equal(state.inputChanges.at(-1), value, 'source insertion must use normal draft persistence');
});

test('an empty draft receives a clean source and the optional time choice persists across reopening', () => {
  const state = harness({ content: '' });
  state.load('clipper-core.js');
  state.load('clipper.js');
  state.context.chrome.tabs = { query(_, callback) { callback([{ title: 'Article', url: 'https://example.org/article' }]); } };
  state.context.Clipper.init();
  state.context.Clipper.addPageSource();
  assert.equal(state.node('#content').val(), '[Article](https://example.org/article)');
  state.node('#sourceIncludeTime').prop('checked', true).trigger('change');
  assert.equal(state.local.memosSourceIncludeTime, true);
  const reopened = harness({ content: '', local: state.local });
  reopened.load('clipper-core.js');
  reopened.load('clipper.js');
  reopened.context.chrome.tabs = state.context.chrome.tabs;
  reopened.context.Clipper.init();
  assert.equal(reopened.node('#sourceIncludeTime').prop('checked'), true);
  reopened.context.Clipper.addPageSource();
  assert.match(reopened.node('#content').val(), /^\[Article\]\(https:\/\/example\.org\/article\)\n\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('task guidance and main-button labels follow the selected main task', () => {
  const state = harness();
  const hints = [];
  for (const task of ['organize', 'summary', 'keypoints', 'qa']) {
    state.node('#aiTask').val(task).trigger('change');
    hints.push(state.node('#aiTaskHelp').text());
    assert.match(state.node('#ai_optimize').attr('title'), new RegExp('aiTask_' + task));
  }
  assert.ok(hints.every(value => value.length > 0));
  assert.equal(new Set(hints).size, 4, 'each task needs its own explanation');
});

test('a named quick preset reveals its actual task and preserves the main task choice', async () => {
  const state = harness();
  state.node('#aiTask').val('summary').trigger('change');
  const preset = { provider: 'openai', model: 'gpt-4.1', task: 'qa', name: 'My custom label' };
  const label = state.context.getPresetLabel(preset, 0);
  assert.ok(label.includes(preset.name));
  assert.ok(label.includes('aiTask_qa'), 'a custom name must not hide the preset task');
  state.context.optimizeWithAI(preset);
  assert.equal(state.node('#aiTask').val(), 'summary');
  assert.match(state.node('#aiTaskStatus').text(), /aiTask_qa/);
  assert.equal(state.node('#aiTaskStatus').prop('hidden'), false);
  assert.match(JSON.parse(state.requests[0].data).instructions, /\*\*Q:\*\*/);
  state.requests[0].success({ output_text: '**Q:** Question?\n**A:** Answer.' });
  await flush();
  assert.match(state.node('#aiReviewTask').text(), /aiTask_qa/);
  assert.equal(state.node('#aiTask').val(), 'summary');
  const reopened = harness({ content: state.node('#content').val(), local: state.local });
  assert.match(reopened.node('#aiReviewTask').text(), /aiTask_qa/);
});

test('the real AI request retains its input snapshot and cannot overwrite edits made while waiting', async () => {
  const state = harness();
  state.node('#aiTask').val('summary');
  state.context.optimizeWithAI();
  state.context.optimizeWithAI();
  assert.equal(state.requests.length, 1, 'a second click must not create another AI request');
  assert.equal(state.context.AIReview.isBusy(), true);
  assert.equal(JSON.parse(state.requests[0].data).input, 'Original draft');
  state.node('#content').val('Latest user edit').trigger('input');
  state.requests[0].success({ output_text: 'AI summary' });
  await flush();
  assert.equal(state.context.AIReview.isBusy(), false);
  assert.equal(state.node('#content').val(), 'Latest user edit');
  assert.equal(state.local.memosAIReview.input, 'Original draft');
  assert.equal(state.node('#aiReviewReplace').prop('disabled'), true);
  assert.match(state.node('#aiReviewWarning').text(), /aiEditConflict/);
  state.node('#aiReviewReplace').click();
  assert.equal(state.node('#content').val(), 'Latest user edit');
  state.node('#aiReviewAppend').click();
  assert.equal(state.node('#content').val(), 'Latest user edit\n\nAI summary');
  state.node('#aiUndo').click();
  assert.equal(state.node('#content').val(), 'Latest user edit');
});

test('a failed AI request leaves the original draft editable and available', async () => {
  const state = harness();
  state.context.optimizeWithAI();
  state.requests[0].error({ status: 500, statusText: 'failure', responseJSON: { error: { message: 'Temporary failure' } } }, 'error', 'server failed');
  await flush();
  assert.equal(state.node('#content').val(), 'Original draft');
  assert.equal(state.context.AIReview.isBusy(), false);
  assert.equal(state.local.memosAIReview, undefined);
  state.context.optimizeWithAI();
  assert.equal(state.requests.length, 2, 'failure must release the busy guard for retry');
  state.requests[1].success({ output_text: 'Recovered result' });
  await flush();
  assert.equal(state.node('#content').val(), 'Original draft');
});

test('adoption fires normal draft persistence, and undo cannot discard later manual edits', () => {
  const state = harness();
  state.context.AIReview.show('Original draft', 'Adopted result', 'organize');
  state.node('#aiReviewReplace').click();
  assert.equal(state.node('#content').val(), 'Adopted result');
  assert.deepEqual(state.inputChanges, ['Adopted result']);
  assert.equal(state.local.memosAIReview, null);
  assert.equal(state.local.memosAIUndo.before, 'Original draft');
  assert.equal(state.local.memosAIUndo.after, 'Adopted result');
  state.node('#content').val('Adopted result plus a manual addition').trigger('input');
  state.node('#aiUndo').click();
  assert.equal(state.node('#content').val(), 'Adopted result plus a manual addition');
  assert.equal(state.messages.at(-1), 'aiUndoConflict');
  state.node('#content').val('Adopted result').trigger('input');
  state.node('#aiUndo').click();
  assert.equal(state.node('#content').val(), 'Original draft');
  assert.equal(state.local.memosAIUndo, null);
  assert.equal(state.node('#aiUndo').prop('disabled'), true);
});

test('pending review edits survive reopening without changing the original draft', () => {
  const state = harness();
  state.context.AIReview.show('Original draft', 'First AI result', 'qa');
  state.node('#aiReviewResult').val('User-corrected AI result').trigger('input');
  const reopened = harness({ local: state.local, content: 'Original draft' });
  assert.equal(reopened.node('#aiReviewPanel').prop('hidden'), false);
  assert.equal(reopened.node('#aiReviewOriginal').val(), 'Original draft');
  assert.equal(reopened.node('#aiReviewResult').val(), 'User-corrected AI result');
  assert.equal(reopened.node('#aiReviewReplace').prop('disabled'), false);
  assert.equal(reopened.node('#content').val(), 'Original draft');
  reopened.node('#aiReviewReplace').click();
  assert.equal(reopened.node('#content').val(), 'User-corrected AI result');
});

test('the actual draft-load callback refreshes adoption after a review restores before the editor', () => {
  const review = { input: 'Restored draft', result: 'Restored AI result', task: 'summary' };
  const state = harness({ content: '', local: { memosAIReview: review } });
  assert.equal(state.node('#aiReviewReplace').prop('disabled'), true);
  let finishDraftLoad;
  state.context.DraftStorage = {
    get: async () => ({}),
    load(callback) { finishDraftLoad = callback; return Promise.resolve(); },
    save(value, callback) { state.local.memosDraft = plain(value); callback?.(); }
  };
  state.context.Workspace = { configure() {}, refreshVisibility() {} };
  state.load('editor-draft.js');
  state.load('oper.js');
  assert.equal(typeof finishDraftLoad, 'function');
  finishDraftLoad({ open_content: 'Restored draft', open_action: 'save_text' });
  assert.equal(state.node('#content').val(), 'Restored draft');
  assert.equal(state.node('#aiReviewReplace').prop('disabled'), false);
  assert.equal(state.node('#aiReviewWarning').prop('hidden'), true);
});

test('adoption and undo are guarded while an AI request or Memo save is in progress', () => {
  const state = harness();
  state.context.AIReview.show('Original draft', 'AI result', 'summary');
  state.context.AIReview.setBusy(true);
  state.node('#aiReviewReplace').click();
  state.node('#aiReviewAppend').click();
  assert.equal(state.node('#content').val(), 'Original draft');
  state.context.AIReview.setBusy(false);
  state.context.memoSaveInProgress = true;
  state.node('#aiReviewReplace').click();
  assert.equal(state.node('#content').val(), 'Original draft');
  state.context.memoSaveInProgress = false;
  state.node('#aiReviewReplace').click();
  state.context.memoSaveInProgress = true;
  state.node('#aiUndo').click();
  assert.equal(state.node('#content').val(), 'AI result');
});

test('saving a matching Memo clears its undo transaction but does not clear unrelated review state', () => {
  const state = harness();
  state.context.AIReview.show('Original draft', 'AI result', 'summary');
  state.context.AIReview.onMemoSaved('Unrelated memo');
  assert.equal(state.local.memosAIReview.input, 'Original draft');
  state.node('#aiReviewReplace').click();
  state.context.AIReview.onMemoSaved('Unrelated memo');
  assert.equal(state.local.memosAIUndo.after, 'AI result');
  state.context.AIReview.onMemoSaved('AI result');
  assert.equal(state.local.memosAIUndo, null);
  assert.equal(state.node('#aiUndo').prop('disabled'), true);
});

test('legacy model-only presets retain provider/model choices and default to the organize task', () => {
  const state = harness();
  const migrated = plain(state.context.normalizeQuickPresets([
    { provider: 'openai', model: 'gpt-4.1' },
    { provider: 'deepseek', model: 'older-custom-model' },
    {}
  ]));
  assert.deepEqual(migrated, [
    { provider: 'openai', model: 'gpt-4.1', customModel: '', name: '', task: 'organize', prompt: '' },
    { provider: 'deepseek', model: 'custom', customModel: 'older-custom-model', name: '', task: 'organize', prompt: '' },
    {}
  ]);
});

test('local task presets override synced legacy presets and keep prompts out of the legacy sync record', () => {
  const custom = { provider: 'openai', model: 'gpt-4.1', task: 'custom', name: 'Compare arguments', prompt: 'Compare the supported arguments.' };
  const state = harness({
    sync: { llmQuickPresets: [{ provider: 'openai', model: 'gpt-5.5' }] },
    local: { llmTaskPresets: [custom] }
  });
  const loaded = plain(vm.runInContext('llmQuickPresets', state.context));
  assert.equal(loaded[0].model, 'gpt-4.1');
  assert.equal(loaded[0].task, 'custom');
  assert.equal(loaded[0].prompt, custom.prompt);
  let saved = false;
  state.context.persistLLMState(() => { saved = true; });
  assert.equal(saved, true);
  assert.equal(state.local.llmTaskPresets[0].prompt, custom.prompt);
  assert.deepEqual(state.sync.llmQuickPresets[0], { provider: 'openai', model: 'gpt-4.1', customModel: '' });
});

test('task-specific instructions are passed into real provider request bodies', async () => {
  const state = harness();
  const instructions = [];
  for (const task of ['organize', 'summary', 'keypoints', 'qa', 'custom']) {
    const pending = state.context.callLLMAPI('openai', 'gpt-5.5', 'ai-test-key', 'Material with https://example.org/source', 'en', '', task,
      task === 'custom' ? 'Compare supporting and opposing arguments.' : '');
    const request = state.requests.at(-1);
    const body = JSON.parse(request.data);
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.input, 'Material with https://example.org/source');
    assert.equal(request.headers.Authorization, 'Bearer ai-test-key');
    instructions.push(body.instructions);
    request.success({ output_text: 'A reviewed result' });
    assert.equal(await pending, 'A reviewed result');
  }
  assert.equal(new Set(instructions).size, 5);
  assert.match(instructions[1], /concise.*summary/i);
  assert.match(instructions[3], /\*\*Q:\*\*/);
  assert.match(instructions[4], /Compare supporting and opposing arguments\./);
  assert.ok(instructions.every(prompt => /source links/.test(prompt)));
});
