/** AI responses remain separate from the draft until explicitly adopted. */
var AIReview = (function () {
  var currentReview = null;
  var lastTransaction = null;
  var busy = false;
  var runningTask = 'organize';

  function message(key) { return getLLMMessage(key, key); }

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

  function taskName(task) { return message('aiTask_' + AIWorkflow.normalizeTask(task)); }

  function refreshTaskHint() {
    var selected = AIWorkflow.normalizeTask($('#aiTask').val());
    $('#aiTaskHelp').text(message('aiTaskHelp_' + selected));
    $('#ai_optimize').attr('title', message('aiRunTask').replace('{task}', taskName(selected)));
    $('#aiTaskStatus').text(message('aiRunningTask').replace('{task}', taskName(runningTask))).prop('hidden', !busy);
    $('#aiReviewTask').text(currentReview ? message('aiExecutedTask').replace('{task}', taskName(currentReview.task)) : '');
  }

  function renderWarning() {
    var warnings = [];
    var empty = !currentReview || !currentReview.result.trim();
    if (currentReview && $('#content').val() !== currentReview.input) warnings.push(message('aiEditConflict'));
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
      $('#aiReviewResult').val(currentReview.result);
    }
    renderWarning();
    refreshTaskHint();
  }

  function show(input, result, task) {
    currentReview = AIWorkflow.review(input, result, task);
    persist();
    render();
  }

  function adopt(mode) {
    if (!currentReview || !currentReview.result.trim() || busy || (typeof memoSaveInProgress !== 'undefined' && memoSaveInProgress)) return;
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
      $('#content').val(AIWorkflow.undo(lastTransaction, $('#content').val())).trigger('input');
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

  function init() {
    chrome.storage.local.get({ memosAIReview: null, memosAIUndo: null, memosAITask: 'organize' }, function (data) {
      var value = data.memosAIReview;
      if (value && typeof value.input === 'string' && typeof value.result === 'string') currentReview = value;
      var transaction = data.memosAIUndo;
      if (transaction && typeof transaction.before === 'string' && typeof transaction.after === 'string') lastTransaction = transaction;
      $('#aiTask').val(AIWorkflow.normalizeTask(data.memosAITask));
      render();
      refreshTexts();
    });
    $('#aiTask').on('change', function () {
      chrome.storage.local.set({ memosAITask: AIWorkflow.normalizeTask(this.value) });
      refreshTaskHint();
    });
    $('#aiReviewReplace').click(function () { adopt('replace'); });
    $('#aiReviewAppend').click(function () { adopt('append'); });
    $('#aiReviewDiscard').click(function () { currentReview = null; persist(); render(); });
    $('#aiReviewResult').on('input', function () {
      if (!currentReview) return;
      currentReview.result = this.value;
      persist();
      renderWarning();
    });
    $('#content').on('input', renderWarning);
    $('#aiUndo').click(undo);
  }

  return { init: init, show: show, refresh: renderWarning, refreshTaskHint: refreshTaskHint, refreshTexts: refreshTexts, onMemoSaved: onMemoSaved,
    isBusy: function () { return busy; }, setBusy: function (value, task) {
      busy = value;
      if (task) runningTask = AIWorkflow.normalizeTask(task);
      renderWarning();
      refreshTaskHint();
    } };
})();
