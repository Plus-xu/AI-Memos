/** Local drafts avoid storage.sync's per-item quota. Read old synced drafts on first use. */
var DraftStorage = (function () {
  var appendQueue = Promise.resolve();
  function load(callback) {
    chrome.storage.local.get({ memosDraft: null }, function (items) {
      if (items.memosDraft && typeof items.memosDraft.open_content === 'string') {
        callback(items.memosDraft);
        return;
      }
      chrome.storage.sync.get({ open_action: '', open_content: '' }, callback);
    });
  }

  function save(draft, callback) {
    chrome.storage.local.set({
      memosDraft: { open_action: draft.open_action || '', open_content: draft.open_content || '' }
    }, function () {
      var error = chrome.runtime.lastError;
      if (error) console.error('Draft storage failed', { message: error.message });
      if (callback) callback(error);
    });
  }

  function append(content, callback) {
    appendQueue = appendQueue.then(function () {
      return new Promise(function (resolve) {
        load(function (draft) {
          var current = draft.open_content || '';
          var combined = (current ? current.replace(/\s+$/, '') + '\n\n' : '') + content;
          save({ open_action: 'save_text', open_content: combined }, function (error) {
            if (callback) callback(error, combined);
            resolve();
          });
        });
      });
    });
    return appendQueue;
  }

  return { load: load, save: save, append: append };
})();
