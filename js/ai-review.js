/* global AIWorkflow, DraftStorage, getLLMMessage, memoSaveInProgress */
/* exported AIReview */
/** AI responses remain separate from the draft until explicitly adopted. */
var AIReview = (function () {
  var currentReview = null;
  var lastTransaction = null;
  var busy = false;
  var runningTask = 'organize';
  // The answer this editor is generating, as { input, text, task }: shown while it arrives, never stored.
  var streaming = null;
  // Whether a frame is awaited in which the text that arrived since the last one will be drawn.
  var frameAwaited = false;
  // Stops the generation this editor started; only that editor has a stop button.
  var stopGeneration = null;

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
      streaming
        ? message('aiRunningTask').replace('{task}', taskName(streaming.task))
        : currentReview
          ? message('aiExecutedTask').replace('{task}', taskName(currentReview.task))
          : ''
    );
  }

  function renderWarning() {
    var warnings = [];
    // Text that is still arriving is not a review yet: nothing is said about it and it cannot be adopted.
    var review = streaming ? null : currentReview;
    var empty = !review || !review.result.trim();
    if (review && $('#content').val() !== review.input) warnings.push(message('aiEditConflict'));
    if (review && review.truncated) warnings.push(message(AIWorkflow.incompleteMessage(review.truncated)));
    if (review && AIWorkflow.missingReferences(review).length) warnings.push(message('aiMissingLinks'));
    $('#aiReviewWarning').text(warnings.join(' ')).prop('hidden', !warnings.length);
    $('#aiReviewReplace').prop('disabled', busy || empty || $('#content').val() !== review.input);
    $('#aiReviewAppend').prop('disabled', busy || empty);
    $('#aiUndo').prop('disabled', !lastTransaction || busy);
  }

  function render() {
    var shown = streaming || currentReview;
    $('#aiReviewPanel').prop('hidden', !shown);
    if (shown) $('#aiReviewOriginal').val(shown.input);
    // Text that is still arriving is put in the box by stream() and draw(), a frame at a time. A result may
    // come before the frame its last text waited for, with a reader still selecting in the box.
    if (!streaming && currentReview) put($('#aiReviewResult')[0], currentReview.result);
    $('#aiReviewResult').prop('readOnly', !!streaming);
    $('#aiReviewDiscard').prop('disabled', !!streaming);
    renderWarning();
    refreshTaskHint();
  }

  function show(input, result, task, truncated) {
    currentReview = AIWorkflow.review(input, result, task, truncated);
    streaming = null;
    persist();
    render();
  }

  /**
   * Shows the text of a generation still running, in place of a pending review, until show() or
   * setBusy(false). The first text opens the panel at once, read from its start. Later text can arrive
   * faster than a page lays it out, so the box takes the latest of it once a frame and nothing else changes:
   * what the reader has selected in the box stays selected.
   */
  function stream(input, text, task) {
    var opening = !streaming;
    streaming = { input: input, text: text, task: AIWorkflow.normalizeTask(task) };
    if (opening) {
      render();
      $('#aiReviewResult').val(text);
    } else if (!frameAwaited) {
      frameAwaited = true;
      requestAnimationFrame(draw);
    }
  }

  function draw() {
    frameAwaited = false;
    // The generation may have ended since this frame was asked for.
    if (!streaming) return;
    var box = $('#aiReviewResult')[0];
    // The box keeps up with the text only for a reader who is at its end.
    var follow = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
    put(box, streaming.text);
    if (follow) box.scrollTop = box.scrollHeight;
  }

  /** Makes `text` what the box holds, with what is selected in it still selected. */
  function put(box, text) {
    var had = box.value;
    if (text === had) return;
    // Assigning the value would drop the selection, so more text is added after what is there.
    if (text.startsWith(had)) box.setRangeText(text.slice(had.length), had.length, had.length, 'preserve');
    else {
      var selected = [Math.min(box.selectionStart, text.length), Math.min(box.selectionEnd, text.length)];
      var direction = box.selectionDirection;
      box.value = text;
      box.setSelectionRange(selected[0], selected[1], direction);
    }
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

  /**
   * `stop`, given by the editor that starts a generation, is what its stop button calls. An editor also
   * hears of its own job through storage, without one: that leaves the button as it is.
   */
  function setBusy(value, task, stop) {
    busy = value;
    if (task) runningTask = AIWorkflow.normalizeTask(task);
    if (typeof stop === 'function') stopGeneration = stop;
    if (!busy) {
      stopGeneration = null;
      streaming = null;
    }
    $('#aiStop').prop('hidden', !stopGeneration);
    $('#ai_optimize, #ai_quick_toggle').prop('disabled', busy);
    render();
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
      if (streaming) return;
      currentReview = null;
      persist();
      render();
    });
    $('#aiReviewResult').on('input', function () {
      if (!currentReview || streaming) return;
      currentReview.result = this.value;
      persist();
      renderWarning();
    });
    $('#content').on('input', renderWarning);
    $('#aiUndo').click(undo);
    $('#aiStop').click(function () {
      var stop = stopGeneration;
      if (!stop) return;
      stopGeneration = null;
      $('#aiStop').prop('hidden', true);
      stop();
    });
  }

  return {
    init: init,
    show: show,
    stream: stream,
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
