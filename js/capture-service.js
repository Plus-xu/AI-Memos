/* global ClipperCore, DraftStorage, StagedFiles */
/* exported CaptureService */
/** Service worker owns right-click and explicit editor captures. */
var CaptureService = (function () {
  // One clip stages at most this many images and this many bytes; the rest stay where they are.
  const MAX_IMAGES = 30,
    MAX_BYTES = 60 * 1024 * 1024;

  // An image left on its own server: an embed when it has a web address, else its description.
  function remoteImage(image) {
    if (!/^https?:/i.test(image.url)) return image.alt || '';
    const alt = (image.alt || '').replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ');
    return '![' + alt + '](' + image.url.replaceAll('(', '%28').replaceAll(')', '%29') + ')';
  }

  async function readPage(tab, mode, frameId) {
    ClipperCore.safeUrl(tab.url);
    const target = { tabId: tab.id, frameIds: [frameId || 0] };
    await chrome.scripting.executeScript({ target, files: ['js/vendor/clipper-libraries.js', 'js/page-capture.js'] });
    const [injection] = await chrome.scripting.executeScript({
      target,
      func: value => globalThis.readMemosClip(value),
      args: [mode]
    });
    if (!injection?.result || injection.result.kind === 'empty') throw new Error('emptySelection');
    return injection.result;
  }

  async function add(tab, mode, info = {}) {
    const url = ClipperCore.safeUrl(info.frameUrl || info.pageUrl || tab.url);
    let page = { url, title: tab.title || url, kind: 'selection', images: [] };
    const budget = { each: await StagedFiles.limit(), left: MAX_BYTES };
    if (mode === 'image') {
      let src = info.srcUrl;
      if (String(src).startsWith('blob:')) {
        const target = { tabId: tab.id, frameIds: [info.frameId || 0] };
        await chrome.scripting.executeScript({ target, files: ['js/page-capture.js'] });
        const [image] = await chrome.scripting.executeScript({
          target,
          func: url => globalThis.readMemosImage(url),
          args: [src]
        });
        src = image.result;
      }
      page.text = await StagedFiles.fromUrl(src, undefined, budget);
    } else if (mode === 'link') page.text = ClipperCore.safeUrl(info.linkUrl || url);
    else {
      try {
        page = await readPage(tab, mode, info.frameId);
      } catch (error) {
        if (mode === 'selection' && info.selectionText?.trim()) page.text = info.selectionText;
        else if (mode === 'page' && Number.isInteger(tab.id)) {
          page.text = page.title;
          page.kind = 'summary';
        } else throw error;
      }
    }
    const images = page.images || [];
    let partial = images.length > MAX_IMAGES;
    for (let offset = 0; offset < Math.min(images.length, MAX_IMAGES); offset += 4) {
      const batch = images.slice(offset, Math.min(offset + 4, MAX_IMAGES));
      const replacements = await Promise.all(
        batch.map(async image => {
          try {
            return await StagedFiles.fromUrl(image.url, image.alt, budget);
          } catch (error) {
            partial = true;
            if (error.message === 'imageTooLarge') return remoteImage(image);
            return image.alt || (image.url.startsWith('http') ? image.url : '');
          }
        })
      );
      batch.forEach((image, i) => {
        page.text = page.text.replace(image.marker, () => replacements[i]);
      });
    }
    for (const image of images.slice(MAX_IMAGES)) page.text = page.text.replace(image.marker, () => remoteImage(image));
    if (!page.text?.trim()) throw new Error('emptySelection');
    const prefs = await DraftStorage.get('local', { memosClipTemplate: ClipperCore.defaultTemplate });
    let template = prefs.memosClipTemplate;
    try {
      ClipperCore.validateTemplate(template);
    } catch (_) {
      template = ClipperCore.defaultTemplate;
    }
    const source = { url: ClipperCore.safeUrl(page.url), title: page.title };
    const markdown = ClipperCore.format({ ...source, content: page.text }, template);
    await DraftStorage.append(markdown + '\n', null, [source]);
    return { kind: page.kind, partial, source };
  }

  return { add };
})();
