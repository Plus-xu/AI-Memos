/* global ClipperCore, DraftEditor, Workspace, getLLMMessage, memoSaveInProgress */
/* exported Clipper */
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
        var title = String(tab.title || url)
          .replace(/[\\[\]]/g, '\\$&')
          .replace(/[\r\n]+/g, ' ');
        var withTime = !!$('#sourceIncludeTime').prop('checked');
        var source = '[' + title + '](' + url + ')' + (withTime ? '\n\n' + new Date().toISOString() : '');
        var editor = $('#content')[0];
        var current = editor.value;
        var start = typeof editor.selectionStart === 'number' ? editor.selectionStart : current.length;
        var end = typeof editor.selectionEnd === 'number' ? editor.selectionEnd : start;
        var before = current.slice(0, start);
        var after = current.slice(end);
        var separator = withTime ? '\n\n' : ' ';
        var inserted =
          (before && !/\s$/.test(before) ? separator : '') + source + (after && !/^\s/.test(after) ? separator : '');
        if (typeof DraftEditor !== 'undefined') DraftEditor.note({ url, title: tab.title || url });
        editor.value = before + inserted + after;
        editor.focus();
        editor.setSelectionRange(before.length + inserted.length, before.length + inserted.length);
        $('#content').trigger('input');
        if (typeof Workspace !== 'undefined') Workspace.refreshHistory(url);
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
        $.message({ message: getLLMMessage('settingsSaved') });
      });
    } catch (_) {
      $.message({ message: getLLMMessage('clipTemplateInvalid') });
    }
  }

  function init() {
    chrome.storage.local.get(
      { memosClipTemplate: ClipperCore.defaultTemplate, memosSourceIncludeTime: false },
      function (data) {
        try {
          template = ClipperCore.validateTemplate(data.memosClipTemplate);
        } catch (_) {
          template = ClipperCore.defaultTemplate;
        }
        $('#clipTemplate').val(template);
        $('#sourceIncludeTime').prop('checked', !!data.memosSourceIncludeTime);
      }
    );
    $('#captureSource').click(addPageSource);
    $('#sourceIncludeTime').on('change', function () {
      chrome.storage.local.set({ memosSourceIncludeTime: !!this.checked }, function () {
        if (chrome.runtime.lastError) $.message({ message: getLLMMessage('settingsSaveFailed') });
      });
    });
    $('#clipTemplate').on('change', saveTemplate);
    $('#saveTemplate').click(saveTemplate);
    $('#clipTemplateReset').click(function () {
      $('#clipTemplate').val(ClipperCore.defaultTemplate);
      saveTemplate();
    });
  }

  return { init: init, addPageSource: addPageSource };
})();
