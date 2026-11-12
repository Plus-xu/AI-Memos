importScripts('draft-storage.js', 'clipper-core.js');

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    [
      { title: 'AI-MEMOS', id: 'Memos-open-server', contexts: ['action'] },
      { title: chrome.i18n.getMessage('clipSelection'), id: 'Memos-send-selection', contexts: ['selection'] },
      { title: chrome.i18n.getMessage('sendLinkTo'), id: 'Memos-send-link', contexts: ['link', 'page'] },
      { title: chrome.i18n.getMessage('sendImageTo'), id: 'Memos-send-image', contexts: ['image'] }
    ].forEach(function (menu) { chrome.contextMenus.create(menu); });
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === 'Memos-open-server') {
    chrome.storage.sync.get({ apiUrl: '' }, function (items) {
      chrome.tabs.create({ url: items.apiUrl || chrome.runtime.getURL('popup.html') });
    });
    return;
  }
  if (info.menuItemId === 'Memos-send-selection') {
    chrome.storage.local.get({ memosClipTemplate: ClipperCore.defaultTemplate }, function (items) {
      try {
        var template;
        try { template = ClipperCore.validateTemplate(items.memosClipTemplate); }
        catch (_) { template = ClipperCore.defaultTemplate; }
        var clip = ClipperCore.format({
          content: info.selectionText,
          title: tab && tab.title,
          url: info.frameUrl || info.pageUrl || tab && tab.url
        }, template);
        DraftStorage.append(clip + '\n');
      } catch (error) {
        console.error('Selection capture failed', { code: error.message });
      }
    });
    return;
  }
  var content;
  if (info.menuItemId === 'Memos-send-link') content = (info.linkUrl || info.pageUrl || '') + '\n';
  else if (info.menuItemId === 'Memos-send-image') content = '![](' + info.srcUrl + ')\n';
  else return;
  DraftStorage.append(content);
});
