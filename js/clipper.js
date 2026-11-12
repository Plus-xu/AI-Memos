var Clipper = (function () {
  var template = ClipperCore.defaultTemplate;
  var capturing = false;

  function addPageSource() {
    if (capturing || (typeof memoSaveInProgress !== 'undefined' && memoSaveInProgress)) return;
    capturing = true;
    $('#captureSource').prop('disabled', true);
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      try {
        var runtimeError = chrome.runtime.lastError;
        var tab = tabs && tabs[0];
        if (runtimeError || !tab) throw new Error('source_unavailable');
        var url = ClipperCore.safeUrl(tab.url);
        var title = String(tab.title || url).replace(/[\\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ');
        var source = '[' + title + '](' + url + ')\n\n' + new Date().toISOString();
        $('#content').val(ClipperCore.append($('#content').val(), source)).trigger('input');
        $.message({ message: getLLMMessage('clipSourceAdded') });
      } catch (_) {
        $.message({ message: getLLMMessage('clipCaptureFailed') });
      } finally {
        capturing = false;
        $('#captureSource').prop('disabled', false);
      }
    });
  }

  function saveTemplate() {
    try {
      var next = ClipperCore.validateTemplate($('#clipTemplate').val());
      chrome.storage.local.set({ memosClipTemplate: next }, function () {
        if (chrome.runtime.lastError) {
          $.message({ message: getLLMMessage('draftSaveFailed') });
          return;
        }
        template = next;
      });
    } catch (_) {
      $.message({ message: getLLMMessage('clipTemplateInvalid') });
    }
  }

  function init() {
    chrome.storage.local.get({ memosClipTemplate: ClipperCore.defaultTemplate }, function (data) {
      try { template = ClipperCore.validateTemplate(data.memosClipTemplate); } catch (_) { template = ClipperCore.defaultTemplate; }
      $('#clipTemplate').val(template);
    });
    $('#captureSource').click(addPageSource);
    $('#clipTemplate').on('change', saveTemplate);
    $('#clipTemplateReset').click(function () { $('#clipTemplate').val(ClipperCore.defaultTemplate); saveTemplate(); });
  }

  return { init: init, addPageSource: addPageSource };
})();
