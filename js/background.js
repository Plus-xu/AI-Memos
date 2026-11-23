importScripts('draft-storage.js', 'clipper-core.js', 'staged-files.js', 'capture-service.js');

for (const area of ['local', 'sync']) chrome.storage[area].setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, key, contexts] of [
      ['Memos-open-server', 'extName', ['action']],
      ['Memos-send-selection', 'clipSelection', ['selection']],
      ['Memos-send-link', 'clipLink', ['link', 'page']],
      ['Memos-send-image', 'clipImage', ['image']]
    ])
      chrome.contextMenus.create({ id, title: chrome.i18n.getMessage(key), contexts });
  });
});

let captureQueue = Promise.resolve();
function capture(tab, mode, info) {
  const next = captureQueue.then(() => CaptureService.add(tab, mode, info));
  captureQueue = next.catch(() => {});
  return next;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'Memos-open-server') {
    chrome.storage.sync.get({ apiUrl: '' }, data => {
      if (data.apiUrl) chrome.tabs.create({ url: data.apiUrl });
      else chrome.runtime.openOptionsPage();
    });
    return;
  }
  const mode = { 'Memos-send-selection': 'selection', 'Memos-send-image': 'image', 'Memos-send-link': 'link' }[
    info.menuItemId
  ];
  if (!mode) return;
  capture(tab || {}, mode, info)
    .then(() => {
      chrome.action?.setBadgeText({ text: '' });
    })
    .catch(() => {
      chrome.storage.local.set({ memosCaptureError: 'clipContextFailed' });
      chrome.action?.setBadgeText({ text: '!' });
    });
});

chrome.runtime.onMessage?.addListener((request, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL('popup.html')) ||
    request.type !== 'capture' ||
    !['page', 'selection'].includes(request.mode)
  )
    return false;
  chrome.tabs
    .get(request.tabId)
    .then(tab => {
      if (!tab.active || tab.url !== request.url) throw new Error('clipCaptureFailed');
      return capture(tab, request.mode);
    })
    .then(
      result => respond({ result }),
      error => respond({ error: error.message === 'emptySelection' ? 'emptySelection' : 'clipCaptureFailed' })
    );
  return true;
});
