const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { plain, flush } = require('./helpers/scripts.cjs');
const { harness } = require('./helpers/environments.cjs');

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
  state.context.chrome.tabs = {
    query(_, callback) {
      callback([{ title: 'An [article]', url }]);
    }
  };
  state.node('#content')[0].setSelectionRange('Original draft'.length, 'Original draft'.length);
  state.context.Clipper.addPageSource();
  assert.match(
    state.node('#content').val(),
    /^Original draft\s*\[An \\\[article\\\]\]\(https:\/\/example\.org\/read%281%29\?id=2\)/
  );
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
  state.context.chrome.tabs = {
    query(_, callback) {
      callback([{ title: 'Article', url: 'https://example.org/article?id=7' }]);
    }
  };
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
  state.context.chrome.tabs = {
    query(_, callback) {
      callback([{ title: 'Article', url: 'https://example.org/article' }]);
    }
  };
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
  assert.match(
    reopened.node('#content').val(),
    /^\[Article\]\(https:\/\/example\.org\/article\)\n\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  );
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
  assert.equal(JSON.parse(state.requests[0].data).input, '<note>\nOriginal draft\n</note>');
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
  state.requests[0].error(
    { status: 500, statusText: 'failure', responseJSON: { error: { message: 'Temporary failure' } } },
    'error',
    'server failed'
  );
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
    load(callback) {
      finishDraftLoad = callback;
      return Promise.resolve();
    },
    save(value, callback) {
      state.local.memosDraft = plain(value);
      callback?.();
    }
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
  const migrated = plain(
    state.context.normalizeQuickPresets([
      { provider: 'openai', model: 'gpt-4.1' },
      { provider: 'deepseek', model: 'older-custom-model' },
      {}
    ])
  );
  assert.deepEqual(migrated, [
    { provider: 'openai', model: 'gpt-4.1', customModel: '', name: '', task: 'organize', prompt: '' },
    {
      provider: 'deepseek',
      model: 'custom',
      customModel: 'older-custom-model',
      name: '',
      task: 'organize',
      prompt: ''
    },
    {}
  ]);
});

test('local task presets override synced legacy presets and keep prompts out of the legacy sync record', () => {
  const custom = {
    provider: 'openai',
    model: 'gpt-4.1',
    task: 'custom',
    name: 'Compare arguments',
    prompt: 'Compare the supported arguments.'
  };
  const state = harness({
    sync: { llmQuickPresets: [{ provider: 'openai', model: 'gpt-5.5' }] },
    local: { llmTaskPresets: [custom] }
  });
  const loaded = plain(vm.runInContext('llmQuickPresets', state.context));
  assert.equal(loaded[0].model, 'gpt-4.1');
  assert.equal(loaded[0].task, 'custom');
  assert.equal(loaded[0].prompt, custom.prompt);
  let saved = false;
  state.context.persistLLMState(() => {
    saved = true;
  });
  assert.equal(saved, true);
  assert.equal(state.local.llmTaskPresets[0].prompt, custom.prompt);
  assert.deepEqual(state.sync.llmQuickPresets[0], { provider: 'openai', model: 'gpt-4.1', customModel: '' });
});

test('task-specific instructions are passed into real provider request bodies', async () => {
  const state = harness();
  const instructions = [];
  for (const task of ['organize', 'summary', 'keypoints', 'qa', 'custom']) {
    const pending = state.context.callLLMAPI(
      'openai',
      'gpt-5.5',
      'ai-test-key',
      'Material with https://example.org/source',
      'en',
      '',
      task,
      task === 'custom' ? 'Compare supporting and opposing arguments.' : ''
    );
    const request = state.requests.at(-1);
    const body = JSON.parse(request.data);
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.input, '<note>\nMaterial with https://example.org/source\n</note>');
    assert.equal(request.headers.Authorization, 'Bearer ai-test-key');
    instructions.push(body.instructions);
    request.success({ output_text: 'A reviewed result' });
    assert.deepEqual(plain(await pending), { text: 'A reviewed result', truncated: false });
  }
  assert.equal(new Set(instructions).size, 5);
  assert.match(instructions[1], /concise.*summary/i);
  assert.match(instructions[3], /\*\*Q:\*\*/);
  assert.match(instructions[4], /Compare supporting and opposing arguments\./);
  assert.ok(instructions.every(prompt => /source links/.test(prompt)));
});

test('markers echoed around a provider answer do not reach the review', async () => {
  const state = harness();
  const pending = state.context.callLLMAPI('openai', 'gpt-5.5', 'ai-test-key', 'Material', 'en', '', 'organize', '');
  state.requests.at(-1).success({ output_text: '<note>\nA reviewed result\n</note>' });
  assert.deepEqual(plain(await pending), { text: 'A reviewed result', truncated: false });
});

test('a cut-off answer that began by echoing the opening marker reaches the review without it', async () => {
  const state = harness();
  const pending = state.context.callLLMAPI('openai', 'gpt-5.5', 'ai-test-key', 'Material', 'en', '', 'organize', '');
  state.requests.at(-1).success({ status: 'incomplete', output_text: '<note>\nA partial result' });
  assert.deepEqual(plain(await pending), { text: 'A partial result', truncated: true });
});

test('a truncated AI result is reviewable and carries a truncation warning', () => {
  const state = harness();
  state.context.AIReview.show('Original draft', 'Partial result', 'organize', true);
  assert.equal(state.node('#aiReviewResult').val(), 'Partial result');
  assert.equal(state.local.memosAIReview.truncated, true);
  assert.equal(state.node('#aiReviewWarning').prop('hidden'), false);
  assert.match(state.node('#aiReviewWarning').text(), /aiTruncatedWarning/);
  state.context.AIReview.show('Original draft', 'Full result', 'organize');
  assert.equal(state.node('#aiReviewWarning').prop('hidden'), true);
});

test('an invalid output limit is reported and nothing is saved', () => {
  const state = harness();
  const field = state.context.document.getElementById('llmMaxTokens');
  for (const [value, validity] of [
    ['100', {}],
    ['', { badInput: true }]
  ]) {
    field.value = value;
    field.validity = validity;
    let result;
    state.context.persistLLMState(error => {
      result = error;
    });
    assert.equal(result && result.message, 'aiMaxTokensInvalid');
    assert.equal(Object.hasOwn(state.sync, 'llmMaxOutputTokens'), false);
  }
  field.value = '4096';
  field.validity = {};
  let result = 'unset';
  state.context.persistLLMState(error => {
    result = error;
  });
  assert.ok(!result);
  assert.equal(state.sync.llmMaxOutputTokens, 4096);
});

test('the output language choice is saved, and an empty or unknown choice keeps the stored one', () => {
  const save = (state, value) => {
    state.node('#llmOutputLanguage').val(value);
    let result = 'unset';
    state.context.persistLLMState(error => {
      result = error;
    });
    return result;
  };
  const state = harness({ sync: { llmOutputLanguage: 'ui' } });
  assert.ok(!save(state, 'source'));
  assert.equal(state.sync.llmOutputLanguage, 'source');
  for (const unusable of ['', 'bogus']) {
    const kept = harness({ sync: { llmOutputLanguage: 'ui' } });
    assert.ok(!save(kept, unusable));
    assert.equal(kept.sync.llmOutputLanguage, 'ui');
  }
  const fresh = harness();
  assert.ok(!save(fresh, ''));
  assert.equal(fresh.sync.llmOutputLanguage, 'auto');

  const refused = harness({ sync: { llmOutputLanguage: 'ui' } });
  refused.node('#llmMaxTokens').val('100');
  assert.equal(save(refused, 'source').message, 'aiMaxTokensInvalid');
  assert.equal(refused.sync.llmOutputLanguage, 'ui');
});

test('the settings page shows the stored output language', () => {
  const state = harness({ sync: { llmOutputLanguage: 'source' } });
  state.context.initLLMConfig();
  assert.equal(state.node('#llmOutputLanguage').val(), 'source');
  const unknown = harness({ sync: { llmOutputLanguage: 'zh' } });
  unknown.context.initLLMConfig();
  assert.equal(unknown.node('#llmOutputLanguage').val(), 'auto');
});
