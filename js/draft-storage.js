/** Local drafts avoid storage.sync's per-item quota. Read old synced drafts on first use. */
var DraftStorage = (function () {
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

  return { load: load, save: save };
})();
