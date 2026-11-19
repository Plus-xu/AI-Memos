/** Injected in the isolated world only following an explicit clip action. */
globalThis.readMemosImage = async function (source) {
  const url = new URL(source);
  if (url.protocol !== 'blob:' || url.origin !== location.origin) throw new Error('imageCaptureFailed');
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) });
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('imageCaptureFailed');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
};

globalThis.readMemosClip = async function (mode) {
  const title = document.title || location.hostname;
  const url = location.href;
  const description = document.querySelector('meta[name="description"],meta[property="og:description"]')?.content?.trim() || '';
  const selection = window.getSelection();
  const selected = selection && !selection.isCollapsed && selection.rangeCount > 0;
  const tools = globalThis.MemosClipTools;
  const converter = new tools.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  converter.use(tools.gfm);
  converter.remove(['script', 'style', 'iframe', 'form', 'noscript', 'template', 'svg', 'canvas']);
  let fragment;
  let kind;
  if (selected) {
    kind = 'selection';
    fragment = document.createElement('div');
    for (let index = 0; index < selection.rangeCount; index++) fragment.append(selection.getRangeAt(index).cloneContents());
  } else {
    if (mode === 'selection') return { kind: 'empty' };
    const doc = document.cloneNode(true);
    doc.querySelectorAll('script,style,nav,aside,footer,form,[hidden]').forEach(node => node.remove());
    const article = new tools.Readability(doc).parse();
    if (!article || article.textContent.trim().length < 100) return { kind: 'summary', title, url, text: description || title, images: [] };
    kind = 'article';
    fragment = document.createElement('template');
    fragment.innerHTML = article.content;
    fragment = fragment.content;
  }
  const images = [];
  for (const img of fragment.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    let source;
    try { source = new URL(src, document.baseURI); } catch (_) { /* use alternative text */ }
    if (source?.protocol === 'blob:') {
      try { source = new URL(await globalThis.readMemosImage(source.href)); }
      catch (_) { source = null; }
    }
    if (!src || !source || !['http:', 'https:', 'data:'].includes(source.protocol) || source.username || source.password) {
      img.replaceWith(document.createTextNode(img.alt || '')); continue;
    }
    const marker = 'MEMOSIMAGE' + Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('');
    images.push({ marker, url: source.href, alt: img.alt || '' });
    img.replaceWith(document.createTextNode(marker));
  }
  for (const anchor of fragment.querySelectorAll('a[href]')) {
    try {
      const link = new URL(anchor.getAttribute('href'), document.baseURI);
      if (!['http:', 'https:', 'mailto:'].includes(link.protocol) || link.username || link.password) throw Error();
      anchor.setAttribute('href', link.href.replaceAll('(', '%28').replaceAll(')', '%29'));
    } catch (_) { anchor.replaceWith(...anchor.childNodes); }
  }
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  const text = converter.turndown(wrapper).trim();
  return { kind, title, url, text: text || (kind === 'article' ? description || title : ''), images };
};
