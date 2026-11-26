const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { plain, flush, loadScripts } = require('./helpers/scripts.cjs');
const { harness, loadPopup, info: fixtureAccount } = require('./helpers/environments.cjs');
const { streamingFetch } = require('./helpers/http.cjs');

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
  Object.assign(state.context.Workspace, { configure() {}, refreshVisibility() {} });
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

/** One event of an OpenAI stream, named after its type as the service names it. */
const streamed = event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
const delta = text => streamed({ type: 'response.output_text.delta', delta: text });
const completed = streamed({ type: 'response.completed', response: { status: 'completed' } });
/** Long enough for an answer the test has written to be read and shown. */
const shown = () => new Promise(resolve => setTimeout(resolve, 20));

/** An editor whose AI answers are streams the test writes through state.requests. */
function streamingEditor(options) {
  const state = harness(options);
  state.context.fetch = streamingFetch(state.requests);
  return state;
}

test('text appears in the review panel while it streams, read-only and unsaved, then becomes the editable review', async () => {
  const state = streamingEditor();
  state.context.optimizeWithAI();
  assert.equal(state.node('#aiReviewPanel').prop('hidden'), true, 'there is nothing to show before the first text');
  state.requests[0].send(delta('Streamed '));
  await shown();
  assert.equal(state.node('#aiReviewPanel').prop('hidden'), false);
  assert.equal(state.node('#aiReviewResult').val(), 'Streamed ');
  assert.equal(state.node('#aiReviewOriginal').val(), 'Original draft');
  assert.equal(state.node('#aiReviewResult').prop('readOnly'), true);
  assert.equal(state.node('#aiReviewDiscard').prop('disabled'), true);
  assert.equal(state.node('#aiReviewReplace').prop('disabled'), true);
  assert.equal(state.node('#aiReviewWarning').prop('hidden'), true);
  assert.equal(state.node('#aiReviewTask').text(), 'aiRunningTask: aiTask_organize');
  assert.equal(state.local.memosAIReview, undefined, 'text that is still arriving is not stored');

  state.requests[0].send(delta('result'));
  state.requests[0].send(completed);
  state.requests[0].end();
  await shown();
  assert.equal(state.context.AIReview.isBusy(), false);
  assert.equal(state.node('#aiReviewResult').val(), 'Streamed result');
  assert.equal(state.node('#aiReviewResult').prop('readOnly'), false);
  assert.equal(state.node('#aiReviewDiscard').prop('disabled'), false);
  assert.equal(state.node('#aiReviewReplace').prop('disabled'), false);
  assert.equal(state.node('#aiReviewTask').text(), 'aiExecutedTask: aiTask_organize');
  assert.deepEqual(
    [state.local.memosAIReview.result, state.local.memosAIReview.truncated],
    ['Streamed result', undefined]
  );
  assert.equal(state.messages.at(-1), 'aiReviewReady');
  assert.equal(state.node('#aiStop').prop('hidden'), true, 'nothing is left to stop');
});

test('an answer cut at the output limit reaches the review marked as truncated', async () => {
  const state = streamingEditor();
  state.context.optimizeWithAI();
  state.requests[0].send(delta('As far as the limit allowed'));
  state.requests[0].send(streamed({ type: 'response.incomplete', response: { status: 'incomplete' } }));
  state.requests[0].end();
  await shown();
  assert.deepEqual(
    [state.local.memosAIReview.result, state.local.memosAIReview.truncated],
    ['As far as the limit allowed', true]
  );
  assert.match(state.node('#aiReviewWarning').text(), /aiTruncatedWarning/);
  assert.equal(state.messages.at(-1), 'aiTruncatedWarning');
});

test('the stop button appears only while this editor generates, and stopping keeps the partial text for review', async () => {
  const state = streamingEditor();
  // Another editor's generation, as this one hears of it.
  state.context.AIReview.setBusy(true, 'summary');
  assert.notEqual(state.node('#aiStop').prop('hidden'), false, 'a generation started elsewhere cannot be stopped here');
  state.context.AIReview.setBusy(false);

  state.context.optimizeWithAI();
  assert.equal(state.node('#aiStop').prop('hidden'), false);
  state.requests[0].send(delta('Partial result'));
  await shown();
  state.node('#aiStop').click();
  assert.equal(state.node('#aiStop').prop('hidden'), true, 'the button goes as soon as it is pressed');
  await shown();
  assert.equal(state.context.AIReview.isBusy(), false);
  assert.equal(state.node('#content').val(), 'Original draft');
  assert.deepEqual(
    [state.local.memosAIReview.result, state.local.memosAIReview.truncated],
    ['Partial result', 'stopped']
  );
  assert.equal(state.node('#aiReviewResult').val(), 'Partial result');
  assert.equal(state.node('#aiReviewResult').prop('readOnly'), false);
  assert.equal(state.node('#aiReviewWarning').prop('hidden'), false);
  assert.match(state.node('#aiReviewWarning').text(), /aiStoppedWarning/);
  assert.equal(state.messages.at(-1), 'aiStoppedWarning');
  assert.equal(state.node('#aiStop').prop('hidden'), true);
});

test('stopping before any text leaves the draft and an earlier pending review as they were', async () => {
  const state = streamingEditor();
  state.context.AIReview.show('Original draft', 'Earlier result', 'summary');
  const unchanged = () => {
    assert.equal(state.context.AIReview.isBusy(), false);
    assert.equal(state.node('#content').val(), 'Original draft');
    assert.equal(state.local.memosAIReview.result, 'Earlier result');
    assert.equal(state.node('#aiReviewPanel').prop('hidden'), false);
    assert.equal(state.node('#aiReviewResult').val(), 'Earlier result');
    assert.equal(state.node('#aiReviewTask').text(), 'aiExecutedTask: aiTask_summary');
  };

  state.context.optimizeWithAI();
  state.node('#aiStop').click();
  await shown();
  assert.equal(state.messages.at(-1), 'aiStopped', 'a stop is reported as a stop, not as a failure');
  unchanged();

  state.context.optimizeWithAI();
  state.requests[1].fail(new TypeError('network error'));
  await shown();
  assert.equal(state.messages.at(-1), 'aiOptimizeFailed · aiInterrupted');
  unchanged();
});

test('a connection lost midway leaves the partial text marked as interrupted', async () => {
  const state = streamingEditor();
  state.context.optimizeWithAI();
  state.requests[0].send(delta('Half an answer'));
  await shown();
  state.requests[0].fail(new TypeError('network error'));
  await shown();
  assert.equal(state.context.AIReview.isBusy(), false);
  assert.equal(state.node('#content').val(), 'Original draft');
  assert.deepEqual(
    [state.local.memosAIReview.result, state.local.memosAIReview.truncated],
    ['Half an answer', 'interrupted']
  );
  assert.match(state.node('#aiReviewWarning').text(), /aiInterruptedWarning/);
  assert.equal(state.messages.at(-1), 'aiInterruptedWarning');
});

test('while text streams, adopting, discarding and editing the result do nothing', async () => {
  const state = streamingEditor();
  state.context.AIReview.show('Original draft', 'Earlier result', 'summary');
  state.context.optimizeWithAI();
  state.requests[0].send(delta('Streaming'));
  await shown();
  state.context.optimizeWithAI();
  assert.equal(state.requests.length, 1, 'a second click starts nothing');
  state.node('#aiReviewReplace').click();
  state.node('#aiReviewAppend').click();
  assert.equal(state.node('#content').val(), 'Original draft');
  state.node('#aiReviewDiscard').click();
  assert.equal(state.node('#aiReviewPanel').prop('hidden'), false);
  state.node('#aiReviewResult').val('Typed over').trigger('input');
  assert.equal(state.local.memosAIReview.result, 'Earlier result', 'the stored review is neither discarded nor edited');

  state.requests[0].send(delta(' text'));
  state.requests[0].send(completed);
  state.requests[0].end();
  await shown();
  assert.equal(state.node('#aiReviewResult').val(), 'Streaming text');
  state.node('#aiReviewResult').val('Edited afterwards').trigger('input');
  assert.equal(state.local.memosAIReview.result, 'Edited afterwards', 'the finished review can be edited again');
});

test('a job seen through storage does not take the stop button away from the editor that started it', async () => {
  const state = streamingEditor();
  state.context.optimizeWithAI();
  // An editor hears of its own job as every editor does, then waits for the lock its generation holds.
  state.context.navigator = { locks: { request: () => new Promise(() => {}) } };
  state.context.chrome.storage.onChanged.emit({ memosAIJob: { newValue: { id: 'job-1', task: 'organize' } } }, 'local');
  assert.equal(state.node('#aiStop').prop('hidden'), false);
  state.node('#aiStop').click();
  await shown();
  assert.equal(state.messages.at(-1), 'aiStopped');
});

test('the result box follows the arriving text while the reader is at its end, and stays put once they scroll up', () => {
  const state = harness();
  const box = state.node('#aiReviewResult')[0];
  Object.assign(box, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 });
  state.context.AIReview.setBusy(true, 'organize', () => {});
  state.context.AIReview.stream('Original draft', 'Some text', 'organize');
  assert.equal(box.scrollTop, 400, 'the first text is read from its start, however much of it there is');
  box.scrollTop = 396;
  state.context.AIReview.stream('Original draft', 'Some text and more', 'organize');
  state.frame();
  assert.equal(box.scrollTop, 500, 'a reader at the end is kept there');
  box.scrollTop = 120;
  state.context.AIReview.stream('Original draft', 'Some text and more still', 'organize');
  state.frame();
  assert.deepEqual([box.value, box.scrollTop], ['Some text and more still', 120]);
});

test('text that arrives faster than it can be drawn is drawn once a frame, and only into the result box', () => {
  const state = harness();
  const box = state.node('#aiReviewResult')[0];
  let text = '';
  let draws = 0;
  Object.defineProperty(box, 'value', {
    get: () => text,
    set(value) {
      text = value;
      draws++;
    }
  });
  const status = state.node('#aiTaskStatus');
  const say = status.text;
  let said = 0;
  status.text = function (value) {
    if (value !== undefined) said++;
    return say.call(this, value);
  };
  state.context.AIReview.setBusy(true, 'organize', () => {});
  const before = said;
  for (let length = 1; length <= 1000; length++)
    state.context.AIReview.stream('Original draft', 'x'.repeat(length), 'organize');
  assert.deepEqual([text, draws], ['x', 1], 'the first text is shown at once');
  state.frame();
  assert.deepEqual([text.length, draws], [1000, 2], 'and all that came since in one go');
  assert.equal(said - before, 1, 'the status line is written when the text starts, not with every piece');
  state.context.AIReview.stream('Original draft', 'x'.repeat(1001), 'organize');
  state.frame();
  assert.deepEqual([text.length, draws], [1001, 3], 'what comes after a frame is drawn in the next one');
});

test('text of a generation gives way to its result once there is one, and to what was there before when there is none', () => {
  const state = harness();
  // Two pieces: the first is shown at once, the second waits for the next frame.
  const arriving = () => {
    state.context.AIReview.setBusy(true, 'organize', () => {});
    state.context.AIReview.stream('Original draft', 'Arriving text', 'organize');
    state.context.AIReview.stream('Original draft', 'Arriving text, and more', 'organize');
  };
  state.context.AIReview.show('Original draft', 'Earlier result', 'summary', true);
  assert.equal(state.node('#aiReviewWarning').prop('hidden'), false);
  arriving();
  assert.equal(state.node('#aiReviewResult').val(), 'Arriving text');
  assert.equal(state.node('#aiReviewWarning').prop('hidden'), true, 'the warning belongs to the review underneath');
  state.context.AIReview.setBusy(false);
  state.frame();
  assert.equal(
    state.node('#aiReviewResult').val(),
    'Earlier result',
    'a frame left over from the generation draws nothing'
  );
  assert.match(state.node('#aiReviewWarning').text(), /aiTruncatedWarning/);
  assert.equal(state.node('#aiReviewResult').prop('readOnly'), false);
  assert.equal(state.node('#aiReviewDiscard').prop('disabled'), false);
  assert.equal(state.node('#aiReviewTask').text(), 'aiExecutedTask: aiTask_summary');

  arriving();
  state.context.AIReview.show('Original draft', 'Final result', 'organize');
  state.frame();
  assert.equal(state.node('#aiReviewResult').val(), 'Final result');
  assert.equal(state.node('#aiReviewResult').prop('readOnly'), false, 'a result can be edited as soon as it is final');
  state.context.AIReview.setBusy(false);

  state.node('#aiReviewDiscard').click();
  arriving();
  assert.equal(state.node('#aiReviewPanel').prop('hidden'), false);
  state.context.AIReview.setBusy(false);
  assert.equal(state.node('#aiReviewPanel').prop('hidden'), true, 'with no review to return to, the panel closes');
});

test('stopping when only part of an echoed marker has arrived keeps the earlier pending review', async () => {
  for (const pieces of [
    ['<'],
    ['<', 'note'],
    ['\n', '<no'],
    ['\r', '<no'],
    ['<note>'],
    ['<note>\r'],
    ['<note>\n'],
    ['\n\n']
  ]) {
    const state = streamingEditor();
    state.context.AIReview.show('Original draft', 'Earlier result', 'summary');
    state.context.optimizeWithAI();
    for (const piece of pieces) {
      state.requests[0].send(delta(piece));
      await shown();
      state.frame();
    }
    const arrived = JSON.stringify(pieces.join(''));
    assert.equal(state.node('#aiReviewResult').val(), 'Earlier result', arrived + ' is not shown as text');
    state.node('#aiStop').click();
    await shown();
    assert.equal(state.messages.at(-1), 'aiStopped', arrived);
    assert.deepEqual(
      [state.local.memosAIReview.result, state.local.memosAIReview.truncated, state.node('#aiReviewResult').val()],
      ['Earlier result', undefined, 'Earlier result'],
      arrived
    );
  }

  const state = streamingEditor();
  state.context.optimizeWithAI();
  for (const piece of ['<note>\n', 'Text\n', '</no']) state.requests[0].send(delta(piece));
  await shown();
  state.node('#aiStop').click();
  await shown();
  assert.deepEqual([state.local.memosAIReview.result, state.local.memosAIReview.truncated], ['Text', 'stopped']);
});

test('what the reader has selected in the arriving text stays selected as more arrives', () => {
  const state = harness();
  const box = state.node('#aiReviewResult')[0];
  // As on a page: assigning the value moves the selection to the end of the text.
  let text = '';
  Object.defineProperty(box, 'value', {
    get: () => text,
    set(value) {
      text = value;
      box.selectionStart = box.selectionEnd = value.length;
    }
  });
  state.context.AIReview.setBusy(true, 'organize', () => {});
  state.context.AIReview.stream('Original draft', 'Some text', 'organize');
  box.setSelectionRange(5, 9);
  state.context.AIReview.stream('Original draft', 'Some text and more', 'organize');
  state.frame();
  assert.deepEqual([box.value, box.selectionStart, box.selectionEnd], ['Some text and more', 5, 9]);
  state.context.AIReview.stream('Original draft', 'Some text and more', 'organize');
  state.frame();
  assert.deepEqual([box.selectionStart, box.selectionEnd], [5, 9], 'the same text again changes nothing');

  // Text that is not what was there with more after it, as when a marker turns out to be an echo: none of
  // what was selected is left, and the selection is what took its place.
  state.context.AIReview.stream('Original draft', 'Other', 'organize');
  state.frame();
  assert.deepEqual([box.value, box.selectionStart, box.selectionEnd], ['Other', 0, 5]);
});

test('a selection stays on its text when the finished answer brings back a part lost before it', () => {
  const state = harness();
  const box = state.node('#aiReviewResult')[0];
  state.context.AIReview.setBusy(true, 'organize', () => {});
  state.context.AIReview.stream('Original draft', 'Some and more', 'organize');
  box.setSelectionRange(9, 13, 'backward');
  // The whole text, with the part a damaged event had carried.
  state.context.AIReview.stream('Original draft', 'Some text and more', 'organize');
  state.frame();
  assert.deepEqual(
    [box.value.slice(box.selectionStart, box.selectionEnd), box.selectionStart, box.selectionDirection],
    ['more', 14, 'backward']
  );

  // A selection before the part that came back stays where it was, and one that ends there does not grow.
  box.setSelectionRange(0, 4);
  state.context.AIReview.stream('Original draft', 'Some new text and more', 'organize');
  state.frame();
  assert.deepEqual([box.selectionStart, box.selectionEnd], [0, 4]);
});

test('a selection stays on its text when the finished answer fills gaps on both sides of it', () => {
  const selected = 'Three';
  const cases = [
    ['One. Three. Five.', 'Three. One. Two. Three. Four. Five.', 'Three. Four.'],
    [
      'One. Three is the right one. Five.',
      'One. Two mentions Three. Three is the right one. Four. Five.',
      'Three is the right one.'
    ],
    [
      'One. Three is the right one. Five.',
      'One. Three was mentioned earlier. Two. Three is the right one. Four. Five.',
      'Three is the right one.'
    ],
    ['One. Keep this Three. Five.', 'One. Two. Keep this Three. Four mentions Three. Five.', 'Three. Four']
  ];
  for (const [arriving, finished, anchor] of cases) {
    const state = harness();
    const box = state.node('#aiReviewResult')[0];
    asTextBox(box);
    state.context.AIReview.setBusy(true, 'organize', () => {});
    state.context.AIReview.stream('Original draft', arriving, 'organize');
    const start = arriving.indexOf(selected);
    box.setSelectionRange(start, start + selected.length, 'backward');
    state.context.AIReview.stream('Original draft', finished, 'organize');
    state.context.AIReview.show('Original draft', finished, 'organize');
    state.context.AIReview.setBusy(false);
    state.frame();

    const expected = finished.indexOf(anchor);
    assert.equal(box.value, finished);
    assert.deepEqual(
      [box.selectionStart, box.selectionEnd, box.selectionDirection],
      [expected, expected + selected.length, 'backward'],
      finished
    );
  }
});

test('a selection made backwards in the arriving text still grows from its start as more arrives', () => {
  const state = harness();
  const box = state.node('#aiReviewResult')[0];
  state.context.AIReview.setBusy(true, 'organize', () => {});
  state.context.AIReview.stream('Original draft', 'Some text', 'organize');
  // As with Shift and the left arrow key, or dragging towards the start: the end that moves is the first.
  box.setSelectionRange(5, 9, 'backward');
  state.context.AIReview.stream('Original draft', 'Some text and more', 'organize');
  state.frame();
  assert.deepEqual(
    [box.value, box.selectionStart, box.selectionEnd, box.selectionDirection],
    ['Some text and more', 5, 9, 'backward']
  );
});

test('a selection spanning a restored gap keeps both endpoints on their original characters', () => {
  for (const direction of ['forward', 'backward']) {
    const state = harness();
    const box = state.node('#aiReviewResult')[0];
    state.context.AIReview.setBusy(true, 'organize');
    state.context.AIReview.stream('Draft', 'A B C D', 'organize');
    box.setSelectionRange(2, 5, direction);
    state.context.AIReview.show('Draft', 'A + B + C + D', 'organize');
    assert.equal(box.value.slice(box.selectionStart, box.selectionEnd), 'B + C');
    assert.equal(box.selectionDirection, direction);
  }
});

test('a selection made while text arrives is kept when the generation ends before the last text was drawn', () => {
  const selecting = () => {
    const state = harness();
    const box = state.node('#aiReviewResult')[0];
    // As on a page: assigning the value moves the selection to the end of the text.
    let text = '';
    Object.defineProperty(box, 'value', {
      get: () => text,
      set(value) {
        text = value;
        box.selectionStart = box.selectionEnd = value.length;
      }
    });
    state.context.AIReview.setBusy(true, 'organize', () => {});
    state.context.AIReview.stream('Original draft', 'Some text', 'organize');
    box.setSelectionRange(5, 9);
    // This text waits for a frame that the end of the generation comes before.
    state.context.AIReview.stream('Original draft', 'Some text and more', 'organize');
    return { state, box };
  };

  const finished = selecting();
  finished.state.context.AIReview.show('Original draft', 'Some text and more', 'organize');
  finished.state.context.AIReview.setBusy(false);
  finished.state.frame();
  assert.deepEqual(
    [finished.box.value, finished.box.selectionStart, finished.box.selectionEnd],
    ['Some text and more', 5, 9]
  );

  // A result that is not the shown text with more after it keeps as much of the selection as it has text for.
  const changed = selecting();
  changed.state.context.AIReview.show('Original draft', 'Some te', 'organize');
  assert.deepEqual([changed.box.value, changed.box.selectionStart, changed.box.selectionEnd], ['Some te', 5, 7]);
});

/**
 * Makes the element hold its text as a text box on a page does: every line ending becomes a line feed, and
 * assigning the value moves the selection to the end of the text.
 */
function asTextBox(box) {
  let text = '';
  Object.defineProperty(box, 'value', {
    get: () => text,
    set(value) {
      text = value.replace(/\r\n?/g, '\n');
      box.selectionStart = box.selectionEnd = text.length;
    }
  });
}

test('a selection in text that arrives with carriage returns stays as it is while more arrives and when it ends', () => {
  const state = harness();
  const box = state.node('#aiReviewResult')[0];
  asTextBox(box);
  state.context.AIReview.setBusy(true, 'organize', () => {});
  state.context.AIReview.stream('Original draft', 'One\r\nTwo', 'organize');
  assert.equal(box.value, 'One\nTwo');
  box.setSelectionRange(4, 7);
  // The two characters of a line ending may arrive apart.
  for (const text of ['One\r\nTwo\r', 'One\r\nTwo\r\nThree']) {
    state.context.AIReview.stream('Original draft', text, 'organize');
    state.frame();
  }
  assert.deepEqual([box.value, box.selectionStart, box.selectionEnd], ['One\nTwo\nThree', 4, 7]);

  // A caret in the text is a selection of nothing, and stays one.
  box.setSelectionRange(5, 5);
  state.context.AIReview.stream('Original draft', 'One\r\nTwo\r\nThree\r\nFour', 'organize');
  state.frame();
  assert.deepEqual([box.value, box.selectionStart, box.selectionEnd], ['One\nTwo\nThree\nFour', 5, 5]);

  box.setSelectionRange(4, 7);
  state.context.AIReview.show('Original draft', 'One\r\nTwo\r\nThree\r\nFour', 'organize');
  state.context.AIReview.setBusy(false);
  assert.deepEqual([box.value, box.selectionStart, box.selectionEnd], ['One\nTwo\nThree\nFour', 4, 7]);
});

test('a result with carriage returns is kept as the draft will hold it, so adopting it can be undone', () => {
  const state = harness();
  asTextBox(state.node('#content')[0]);
  state.node('#content').val('Original draft');
  state.context.AIReview.show('Original draft', 'First\r\nSecond', 'organize');
  assert.equal(state.local.memosAIReview.result, 'First\nSecond');
  state.node('#aiReviewReplace').click();
  assert.equal(state.node('#content').val(), 'First\nSecond');
  state.node('#aiUndo').click();
  assert.equal(state.node('#content').val(), 'Original draft');
  assert.notEqual(state.messages.at(-1), 'aiUndoConflict');
});

test('a result an earlier version stored with carriage returns can be adopted and the adoption undone', () => {
  const review = { input: 'Original draft', result: 'First\r\nSecond', task: 'organize' };
  const adopting = editor => {
    asTextBox(editor.node('#content')[0]);
    editor.node('#content').val('Original draft');
    editor.node('#aiReviewReplace').click();
    assert.equal(editor.node('#content').val(), 'First\nSecond');
    editor.node('#aiUndo').click();
    assert.equal(editor.node('#content').val(), 'Original draft');
  };
  // Stored before a result was kept as a text box holds it, and found when the editor opens.
  adopting(harness({ local: { memosAIReview: review } }));

  // The same review, heard of from storage while the editor is open.
  const open = harness();
  open.context.chrome.storage.onChanged.emit({ memosAIReview: { newValue: review } }, 'local');
  adopting(open);
});

test('an adoption an earlier version stored with carriage returns can be undone, and is done with when its draft is saved', () => {
  // The draft holds what the adoption wrote as a text box holds it; the record of it has the answer's line endings.
  const adoption = { before: 'Original draft', after: 'First\r\nSecond' };
  const adopted = () => {
    const state = harness({ local: { memosAIUndo: adoption } });
    asTextBox(state.node('#content')[0]);
    state.node('#content').val('First\nSecond');
    return state;
  };
  const undone = adopted();
  undone.node('#aiUndo').click();
  assert.equal(undone.node('#content').val(), 'Original draft');

  const saved = adopted();
  saved.context.AIReview.onMemoSaved('First\nSecond');
  assert.equal(saved.local.memosAIUndo, null);

  const heard = harness();
  asTextBox(heard.node('#content')[0]);
  heard.node('#content').val('First\nSecond');
  heard.context.chrome.storage.onChanged.emit({ memosAIUndo: { newValue: adoption } }, 'local');
  heard.node('#aiUndo').click();
  assert.equal(heard.node('#content').val(), 'Original draft');
});

test('a caret follows the original word when the final answer fills gaps on both sides', () => {
  const state = harness();
  const box = state.node('#aiReviewResult')[0];
  state.context.AIReview.setBusy(true, 'organize', () => {});
  state.context.AIReview.stream('Original draft', 'One. Three. Five.', 'organize');
  box.setSelectionRange(8, 8);
  state.context.AIReview.stream('Original draft', 'One. Two. Three. Four. Five.', 'organize');
  state.frame();
  assert.deepEqual([box.value, box.selectionStart, box.selectionEnd], ['One. Two. Three. Four. Five.', 13, 13]);

  box.setSelectionRange(box.value.length, box.value.length);
  state.context.AIReview.show('Original draft', 'Zero. One. Two. Three. Four. Five.', 'organize');
  assert.equal(box.selectionStart, box.value.length);
  assert.equal(box.selectionEnd, box.value.length);
});

async function popupWithAI(draft, saved, overrides) {
  const popup = await loadPopup(overrides, {
    ...saved,
    open_content: draft,
    userLanguage: 'en',
    llmActiveProvider: 'openai',
    llmProviderConfigs: { openai: { model: 'gpt-5.5', apiKey: 'fixture-key' } }
  });
  popup.context.TextDecoder = TextDecoder;
  popup.context.clearTimeout = clearTimeout;
  popup.context.uiMessage = key => (key === 'aiVisibilityChange' ? '{before} → {after}' : key);
  loadScripts(popup.context, ['llm-config', 'ai-workflow', 'ai-review', 'llm-transport', 'ai-optimize']);
  popup.context.loadLLMState(() => {});
  popup.context.AIReview.init();
  return popup;
}

test('only the latest settings and destination reads can enable adoption', async () => {
  const draft = 'Draft #new';
  const { context, node } = await popupWithAI(draft, { memo_lock: 'PUBLIC' });
  const info = await new Promise(resolve => context.get_info(resolve));
  context.AIReview.show(draft, 'Edited draft', 'organize');
  const settings = [];
  context.get_info = callback => settings.push(callback);
  const get = context.DraftStorage.get;
  let finishDestination;
  context.DraftStorage.get = (area, keys) => {
    if (Object.keys(keys).some(key => key.startsWith('memosDestination:')) && !finishDestination) {
      return new Promise(resolve => {
        finishDestination = () => resolve(keys);
      });
    }
    return get(area, keys);
  };
  const changed = tag => context.chrome.storage.onChanged.emit({ hidetag: { newValue: tag } }, 'sync');

  changed('first');
  settings.shift()({ ...info, hidetag: 'first' });
  await flush();
  changed('second');
  finishDestination();
  await flush();
  assert.equal(context.Workspace.isVisibilityReady(), false);
  assert.equal(node('#aiReviewReplace').prop('disabled'), true);
  assert.equal(node('#content_submit_text').prop('disabled'), true);
  const prematureSave = context.sendText();
  assert.equal(context.memoSaveInProgress, false);
  await prematureSave;

  changed('new');
  const [obsolete, latest] = settings;
  latest({ ...info, hidetag: 'new' });
  await flush();
  obsolete({ ...info, hidetag: 'second' });
  await flush();
  assert.equal(node('#aiReviewReplace').prop('disabled'), false);
  assert.equal(node('#content_submit_text').prop('disabled'), false);
  await assert.rejects(context.Workspace.destination(info), /destinationChanged/);
  node('#aiReviewReplace').click();
  assert.equal(node('#content').val(), draft);
  assert.equal(node('#aiVisibilityChange').text(), 'lockPrivate → lockPublic');
});

test('the saved visibility is displayed before adoption and save while spaces load', async () => {
  const draft = 'Original draft';
  const scope = JSON.stringify([fixtureAccount.apiUrl, fixtureAccount.userName]);
  const posts = [];
  let answerSpaces;
  const pending = new Promise(resolve => {
    answerSpaces = resolve;
  });
  const { context, node } = await popupWithAI(
    draft,
    { memo_lock: 'PRIVATE', ['memosDestination:' + scope]: { space: '', visibility: 'PUBLIC' } },
    {
      listSpaces: () => pending,
      createMemo: async (_, body) => {
        posts.push(body);
        return { name: 'memos/saved', ...body };
      }
    }
  );

  context.AIReview.show(draft, 'Edited draft', 'organize');
  assert.equal(node('#visibility').val(), 'PUBLIC');
  assert.equal(node('#aiReviewReplace').prop('disabled'), false);
  assert.equal(node('#content_submit_text').prop('disabled'), false);
  node('#visibility').val('PRIVATE');
  await node('#visibility')[0].onchange();
  node('#aiReviewReplace').click();
  const saving = context.sendText();
  answerSpaces([]);
  await saving;
  assert.deepEqual(plain(posts), [{ content: 'Edited draft', visibility: 'PRIVATE' }]);
});

test('a destination selected in another editor survives an older local read', async () => {
  const { context } = await loadPopup();
  const info = await new Promise(resolve => context.get_info(resolve));
  const key = 'memosDestination:' + context.DraftStorage.scope(info);
  const get = context.DraftStorage.get;
  let finish;
  context.DraftStorage.get = (area, keys) =>
    Object.hasOwn(keys, key)
      ? new Promise(resolve => {
          finish = resolve;
        })
      : get(area, keys);
  const loading = context.Workspace.configure(info);
  const newer = { space: '', visibility: 'PROTECTED' };
  context.chrome.storage.onChanged.emit({ [key]: { newValue: newer } }, 'local');
  finish({ [key]: { space: '', visibility: 'PRIVATE' } });
  await loading;
  assert.deepEqual(plain(await context.Workspace.destination(info)), { visibility: 'PROTECTED' });
});

test('adopting a stopped result that would remove a private tag requires explicit confirmation', async () => {
  const draft = 'Private contents\n#private';
  const saved = [];
  const { context, node, storage, messages } = await popupWithAI(
    draft,
    { hidetag: 'private', memo_lock: 'PUBLIC' },
    {
      createMemo: async (_, body) => {
        saved.push(body);
        return { name: 'memos/saved', ...body };
      }
    }
  );
  const requests = [];
  context.fetch = streamingFetch(requests);
  const job = context.optimizeWithAI();
  await flush();
  assert.equal(requests.length, 1, messages.join(', '));
  requests[0].send(delta('Private contents'));
  await shown();
  node('#aiStop').click();
  await job;
  assert.equal(storage.memosAIReview?.truncated, 'stopped', messages.join(', '));

  node('#aiReviewReplace').click();
  assert.equal(node('#aiVisibilityConfirmation').prop('hidden'), false);
  assert.equal(node('#aiVisibilityChange').text(), 'lockPrivate → lockPublic');
  assert.equal(node('#content').val(), draft);
  assert.equal(storage.memosAIUndo, null);

  node('#aiCancelAdoption').click();
  node('#aiConfirmAdoption').click();
  assert.equal(node('#aiVisibilityConfirmation').prop('hidden'), true);
  assert.equal(node('#content').val(), draft);
  assert.equal(storage.memosAIReview.truncated, 'stopped');

  node('#aiReviewReplace').click();
  node('#aiConfirmAdoption').click();
  assert.equal(node('#content').val(), 'Private contents');
  await context.sendText();
  assert.equal(saved[0].visibility, 'PUBLIC');
});

test('append checks the joined draft and rechecks the currently selected scope at confirmation', async () => {
  const draft = 'Private contents\n```text\nSome code';
  const result = '```\n#publish';
  const { context, node } = await popupWithAI(draft, { showtag: 'publish', memo_lock: 'PRIVATE' });
  const review = context.AIReview;
  review.show(draft, result, 'organize', 'interrupted');

  node('#aiReviewAppend').click();
  assert.equal(node('#aiVisibilityChange').text(), 'lockPrivate → lockPublic');
  assert.equal(node('#content').val(), draft);

  node('#visibility').val('PROTECTED');
  await node('#visibility')[0].onchange();
  node('#aiConfirmAdoption').click();
  assert.equal(node('#aiVisibilityChange').text(), 'lockProtected → lockPublic');
  assert.equal(node('#content').val(), draft, 'the original confirmation has expired');

  node('#aiReviewResult').val('Revised result').trigger('input');
  node('#aiConfirmAdoption').click();
  assert.equal(node('#content').val(), draft, 'changing the result invalidates the confirmation');
  assert.equal(node('#aiVisibilityConfirmation').prop('hidden'), true);
  node('#aiReviewAppend').click();
  assert.equal(node('#content').val(), draft + '\n\nRevised result');
});
