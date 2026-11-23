/** AI responses remain separate from the draft until explicitly adopted. */
var AIReview = (function () {
  var currentReview = null;
  var lastTransaction = null;
  var busy = false;
  var runningTask = 'organize';

  function message(key) {
    return getLLMMessage(key, key);
  }

  function persist() {
    chrome.storage.local.set({ memosAIReview: currentReview, memosAIUndo: lastTransaction }, function () {
      if (chrome.runtime.lastError) $.message({ message: message('draftSaveFailed') });
    });
  }

  function refreshTexts() {
    document.querySelectorAll('[data-feature-message]').forEach(function (element) {
      element.textContent = message(element.getAttribute('data-feature-message'));
    });
    $('#aiTask').attr('aria-label', message('aiTaskLabel'));
    $('#aiUndo').attr('title', message('aiUndo'));
    refreshTaskHint();
    renderWarning();
  }

  function taskName(task) {
    return message('aiTask_' + AIWorkflow.normalizeTask(task));
  }

  function refreshTaskHint() {
    var selected = AIWorkflow.normalizeTask($('#aiTask').val());
    $('#aiTaskHelp').text(message('aiTaskHelp_' + selected));
    const taskLabel = message('aiRunTask').replace('{task}', taskName(selected));
    $('#ai_optimize').attr('title', taskLabel).attr('aria-label', taskLabel);
    $('#ai_optimize span').text('AI · ' + taskName(selected));
    $('#aiTaskStatus')
      .text(message('aiRunningTask').replace('{task}', taskName(runningTask)))
      .prop('hidden', !busy);
    $('#aiReviewTask').text(
      currentReview ? message('aiExecutedTask').replace('{task}', taskName(currentReview.task)) : ''
    );
  }

  function renderWarning() {
    var warnings = [];
    var empty = !currentReview || !currentReview.result.trim();
    if (currentReview && $('#content').val() !== currentReview.input) warnings.push(message('aiEditConflict'));
    if (currentReview && currentReview.truncated) warnings.push(message('aiTruncatedWarning'));
    if (currentReview && AIWorkflow.missingReferences(currentReview).length) warnings.push(message('aiMissingLinks'));
    $('#aiReviewWarning').text(warnings.join(' ')).prop('hidden', !warnings.length);
    $('#aiReviewReplace').prop('disabled', busy || empty || $('#content').val() !== currentReview.input);
    $('#aiReviewAppend').prop('disabled', busy || empty);
    $('#aiUndo').prop('disabled', !lastTransaction || busy);
  }

  function render() {
    $('#aiReviewPanel').prop('hidden', !currentReview);
    if (currentReview) {
      $('#aiReviewOriginal').val(currentReview.input);
      if ($('#aiReviewResult').val() !== currentReview.result) $('#aiReviewResult').val(currentReview.result);
    }
    renderWarning();
    refreshTaskHint();
  }

  function show(input, result, task, truncated) {
    currentReview = AIWorkflow.review(input, result, task, truncated);
    persist();
    render();
  }

  function adopt(mode) {
    if (
      !currentReview ||
      !currentReview.result.trim() ||
      busy ||
      (typeof memoSaveInProgress !== 'undefined' && memoSaveInProgress)
    )
      return;
    try {
      lastTransaction = AIWorkflow.apply(currentReview, $('#content').val(), mode);
      $('#content').val(lastTransaction.after).trigger('input');
      currentReview = null;
      persist();
      render();
      $.message({ message: message('aiResultApplied') });
    } catch (_) {
      $.message({ message: message('aiEditConflict') });
    }
  }

  function undo() {
    if (busy || (typeof memoSaveInProgress !== 'undefined' && memoSaveInProgress)) return;
    try {
      $('#content')
        .val(AIWorkflow.undo(lastTransaction, $('#content').val()))
        .trigger('input');
      lastTransaction = null;
      persist();
      render();
    } catch (_) {
      $.message({ message: message('aiUndoConflict') });
    }
  }

  function onMemoSaved(content) {
    if (currentReview && currentReview.input === content) currentReview = null;
    if (lastTransaction && lastTransaction.after === content) lastTransaction = null;
    persist();
    render();
  }

  const jobKey = 'memosAIJob';
  const jobLock = 'memos-ai-generation';

  function setBusy(value, task) {
    busy = value;
    if (task) runningTask = AIWorkflow.normalizeTask(task);
    $('#ai_optimize, #ai_quick_toggle').prop('disabled', busy);
    renderWarning();
    refreshTaskHint();
  }

  // A closed editor releases its Web Lock even if its request never finished.
  async function observeJob(job) {
    if (!job || typeof navigator === 'undefined' || !navigator.locks) return;
    setBusy(true, job.task);
    await navigator.locks.request(jobLock, async () => {
      const data = await DraftStorage.get('local', { [jobKey]: null });
      if (data[jobKey]?.id === job.id) {
        await DraftStorage.put('local', { [jobKey]: null });
        $.message({ message: message('aiInterrupted') });
      }
      setBusy(false);
    });
  }

  function withJob(task, work) {
    if (typeof navigator === 'undefined' || !navigator.locks) return work();
    return navigator.locks.request(jobLock, { ifAvailable: true }, async lock => {
      if (!lock) {
        $.message({ message: message('aiOptimizing') });
        return;
      }
      const job = { id: crypto.randomUUID(), task };
      await DraftStorage.put('local', { [jobKey]: job });
      try {
        return await work();
      } finally {
        await DraftStorage.put('local', { [jobKey]: null });
      }
    });
  }

  function init() {
    chrome.storage.local.get(
      { memosAIReview: null, memosAIUndo: null, memosAITask: 'organize', memosAIJob: null },
      function (data) {
        var value = data.memosAIReview;
        if (value && typeof value.input === 'string' && typeof value.result === 'string') currentReview = value;
        var transaction = data.memosAIUndo;
        if (transaction && typeof transaction.before === 'string' && typeof transaction.after === 'string')
          lastTransaction = transaction;
        $('#aiTask').val(AIWorkflow.normalizeTask(data.memosAITask));
        render();
        refreshTexts();
        observeJob(data.memosAIJob);
      }
    );
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.memosAIJob?.newValue) observeJob(changes.memosAIJob.newValue);
      if (changes.memosAIReview) currentReview = changes.memosAIReview.newValue || null;
      if (changes.memosAIUndo) lastTransaction = changes.memosAIUndo.newValue || null;
      if (changes.memosAITask) $('#aiTask').val(AIWorkflow.normalizeTask(changes.memosAITask.newValue));
      if (changes.memosAIReview || changes.memosAIUndo || changes.memosAITask) render();
    });
    $('#aiTask').on('change', function () {
      chrome.storage.local.set({ memosAITask: AIWorkflow.normalizeTask(this.value) });
      refreshTaskHint();
    });
    $('#aiReviewReplace').click(function () {
      adopt('replace');
    });
    $('#aiReviewAppend').click(function () {
      adopt('append');
    });
    $('#aiReviewDiscard').click(function () {
      currentReview = null;
      persist();
      render();
    });
    $('#aiReviewResult').on('input', function () {
      if (!currentReview) return;
      currentReview.result = this.value;
      persist();
      renderWarning();
    });
    $('#content').on('input', renderWarning);
    $('#aiUndo').click(undo);
  }

  return {
    init: init,
    show: show,
    refresh: renderWarning,
    refreshTaskHint: refreshTaskHint,
    refreshTexts: refreshTexts,
    onMemoSaved: onMemoSaved,
    isBusy: function () {
      return busy;
    },
    setBusy,
    withJob
  };
})();
