/* Isolated local popup preview. This development server is never packaged. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function chromeRuntime(messages) {
  return `(() => {
  'use strict';
  const messages = ${JSON.stringify(messages).replace(/</g, '\\u003c')};
  const origin = location.origin;
  const storagePrefix = 'ai-memos-preview-v1:';
  const clone = value => JSON.parse(JSON.stringify(value));
  const initial = {
    sync: {
      apiUrl: origin + '/__memos/', apiTokens: 'preview-public-fake-pat', userName: 'users/preview', userid: 'preview',
      memosVersion: '26.11.1', memo_lock: 'PRIVATE', userLanguage: 'zh_CN', theme: 'light',
      llmActiveProvider: 'openai', llmProvider: 'openai', llmModel: 'gpt-6.2-sol', llmApiKey: 'preview-public-fake-key',
      llmProviderConfigs: { openai: { model: 'gpt-6.2-sol', customModel: '', apiKey: 'preview-public-fake-key', baseUrl: '' } },
      llmQuickPresets: [
        { provider: 'openai', model: 'gpt-6.2-sol' },
        { provider: 'openai', model: 'gpt-6.2-sol' },
        { provider: 'openai', model: 'gpt-6.2-sol' }
      ]
    },
    local: {
      memosAITask: 'organize', memosAIReview: null, memosAIUndo: null,
      memosDraft: { open_action: 'save_text', open_content: '数字化治理阅读笔记：\\n1. 服务流程应以群众需求为导向。\\n2. 数据共享需要明确责任和边界。\\n\\n来源：https://example.org/articles/digital-governance\\n#学习 #素材' },
      llmTaskPresets: [
        { name: '阅读摘要', task: 'summary', prompt: '', provider: 'openai', model: 'gpt-6.2-sol', customModel: '' },
        { name: '提取要点', task: 'keypoints', prompt: '', provider: 'openai', model: 'gpt-6.2-sol', customModel: '' },
        { name: '学习问答', task: 'qa', prompt: '', provider: 'openai', model: 'gpt-6.2-sol', customModel: '' }
      ]
    }
  };
  const stores = {};
  for (const area of ['sync', 'local']) {
    try { stores[area] = Object.assign(clone(initial[area]), JSON.parse(localStorage.getItem(storagePrefix + area) || '{}')); }
    catch (_) { stores[area] = clone(initial[area]); }
  }
  const listeners = new Set();
  window.addEventListener('storage', event => {
    const area = (event.key || '').slice(storagePrefix.length);
    if (!event.key?.startsWith(storagePrefix) || !stores[area]) return;
    const after = event.newValue ? JSON.parse(event.newValue) : clone(initial[area]);
    const changes = {};
    for (const key of new Set([...Object.keys(after), ...Object.keys(stores[area])])) {
      if (JSON.stringify(stores[area][key]) !== JSON.stringify(after[key])) changes[key] = { oldValue: stores[area][key], newValue: after[key] };
    }
    stores[area] = after;
    for (const listener of listeners) listener(changes, area);
  });
  const later = callback => queueMicrotask(callback);
  const storageArea = area => ({
    get(keys, callback) {
      const store = stores[area];
      let result;
      if (keys == null) result = clone(store);
      else if (typeof keys === 'string') result = Object.hasOwn(store, keys) ? { [keys]: clone(store[keys]) } : {};
      else if (Array.isArray(keys)) result = Object.fromEntries(keys.filter(key => Object.hasOwn(store, key)).map(key => [key, clone(store[key])]));
      else result = Object.assign(clone(keys), clone(store));
      if (callback) { later(() => callback(result)); return; }
      return Promise.resolve(result);
    },
    set(values, callback) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) changes[key] = { oldValue: stores[area][key], newValue: value };
      Object.assign(stores[area], clone(values));
      localStorage.setItem(storagePrefix + area, JSON.stringify(stores[area]));
      later(() => { if (callback) callback(); for (const listener of listeners) listener(clone(changes), area); });
      if (!callback) return Promise.resolve();
    },
    remove(keys, callback) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete stores[area][key];
      localStorage.setItem(storagePrefix + area, JSON.stringify(stores[area]));
      if (callback) later(callback); else return Promise.resolve();
    }
  });
  const sample = {
    id: 700, url: 'https://example.org/articles/digital-governance', title: '数字化治理：服务、责任与协同',
    content: '完善便民服务，要从群众的实际需求出发。\\n跨部门数据共享，应同步明确责任边界和纠错机制。'
  };
  const noopEvent = { addListener() {}, removeListener() {} };
  const runtime = {
    lastError: null, id: 'ai-memos-local-preview', onInstalled: noopEvent, onMessage: noopEvent,
    getURL: file => new URL('/' + String(file).replace(/^\\/+/, ''), origin).href,
    openOptionsPage: async () => { window.open('/options.html','_blank','noopener'); },
    async sendMessage(request) {
      if (request.type !== 'capture') return { error:'clipCaptureFailed' };
      const { url, title, content } = sample;
      const source = { url, title };
      const { memosClipTemplate: template } = await DraftStorage.get('local', { memosClipTemplate:ClipperCore.defaultTemplate });
      await DraftStorage.append(ClipperCore.format({ url, title, content }, template), null, [source]);
      return { result:{ kind:request.mode === 'selection' ? 'selection' : 'article', source } };
    },
    getManifest: () => ({ name: 'AI-MEMOS 本地预览', version: '2026.11.19.1' }), reload: () => location.reload()
  };
  const chrome = {
    runtime, windows:{ getCurrent:async () => ({ id:1 }) }, sidePanel:{ open:async () => { window.open('/panel.html','_blank','noopener'); } },
    i18n: {
      getUILanguage: () => 'zh-CN',
      getMessage(key, substitutions) {
        let message = messages[key]?.message || key;
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        values.forEach((value, index) => { if (value != null) message = message.replaceAll('$' + (index + 1), String(value)); });
        return message;
      }
    },
    storage: { sync: storageArea('sync'), local: storageArea('local'), onChanged: {
      addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener)
    } },
    tabs: {
      query(_query, callback) { if (callback) later(() => callback([clone(sample)])); else return Promise.resolve([clone(sample)]); },
      create(options, callback) {
        document.getElementById('previewStatus').textContent = '已模拟打开链接，未离开本地预览：' + String(options.url || '');
        if (callback) later(() => callback(clone(sample))); else return Promise.resolve(clone(sample));
      }
    },
    contextMenus: { create() {}, removeAll(callback) { if (callback) later(callback); }, onClicked: noopEvent }
  };
  if (window.chrome) Object.assign(window.chrome, chrome);
  else window.chrome = chrome;
  const preview = { failAI: false, failSave: false, sample, stores, memos: new Map(), attachments: new Map(), requests: [] };
  window.__AI_MEMOS_PREVIEW__ = preview;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname.endsWith('/models')) {
      const data = url.hostname.includes('googleapis') ? { models:[{ name:'models/preview-text', supportedGenerationMethods:['generateContent'] }] } : { data:[{ id:'preview-text' }] };
      return Promise.resolve(Response.json(data));
    }
    if (url.origin !== origin) return Promise.reject(new Error('Local preview blocks external requests'));
    if (url.pathname.startsWith('/__memos/file/attachments/')) {
      return Promise.resolve(new Response('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><rect width="180" height="120" fill="#e5e7eb"/><text x="20" y="65" fill="#374151">Preview attachment</text></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }));
    }
    return nativeFetch(input, options);
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('previewReset').addEventListener('click', () => {
      for (const area of ['sync', 'local']) localStorage.removeItem(storagePrefix + area);
      location.reload();
    });
    document.getElementById('previewFailAI').addEventListener('click', () => {
      preview.failAI = true; document.getElementById('previewStatus').textContent = '下次 AI 请求将模拟失败。';
    });
    document.getElementById('previewFailSave').addEventListener('click', () => {
      preview.failSave = true; document.getElementById('previewStatus').textContent = '下次 Memo 保存将模拟失败。';
    });
  });
})();`;
}

function ajaxRuntime() {
  return `(() => {
  'use strict';
  const preview = window.__AI_MEMOS_PREVIEW__;
  const clone = value => JSON.parse(JSON.stringify(value));
  const initialMemo = { name: 'memos/preview-note', creator: 'users/preview', content: '预览中的示例笔记\\n#学习', tags: ['学习'], visibility: 'PRIVATE', createTime: new Date().toISOString(), attachments: [] };
  preview.memos.set(initialMemo.name, initialMemo);
  function bodyOf(options) { if (!options.data) return {}; return typeof options.data === 'string' ? JSON.parse(options.data) : options.data; }
  function userText(body) {
    if (typeof body.input === 'string') return body.input;
    if (Array.isArray(body.input)) return body.input.map(item => typeof item.content === 'string' ? item.content : (item.content || []).map(part => part.text || '').join('\\n')).join('\\n');
    if (Array.isArray(body.messages)) {
      const user = body.messages.filter(item => item.role === 'user').at(-1);
      return typeof user?.content === 'string' ? user.content : (user?.content || []).map(part => part.text || '').join('\\n');
    }
    return (body.contents || []).flatMap(item => item.parts || []).map(part => part.text || '').join('\\n');
  }
  function aiResult(body) {
    const input = userText(body);
    const instructions = String(body.instructions || body.system || body.system_instruction?.parts?.[0]?.text || body.systemInstruction?.parts?.[0]?.text || body.messages?.[0]?.content || '');
    const links = Array.from(new Set(input.match(/https?:\\/\\/[^\\s<>"'\\])]+/g) || []));
    let result;
    if (/study questions|question.*answer|学习问答|问答/i.test(instructions)) result = '**Q:** 完善便民服务的出发点是什么？\\n\\n**A:** 群众的实际需求。\\n\\n**Q:** 跨部门共享数据需要同步明确什么？\\n\\n**A:** 责任边界和纠错机制。';
    else if (/key points|提取要点/i.test(instructions)) result = '## 核心要点\\n\\n- **服务导向**：从群众实际需求出发。\\n- **协同治理**：共享数据时明确责任边界。\\n- **持续改进**：建立纠错机制。';
    else if (/concise.*summary|阅读摘要|摘要/i.test(instructions)) result = '数字化治理应以群众需求为导向，并在推进跨部门数据共享时明确责任边界、建立纠错机制。';
    else result = '## 数字化治理阅读笔记\\n\\n1. **服务导向**：服务流程应以群众需求为导向。\\n2. **责任边界**：数据共享需要明确责任和边界。\\n\\n#学习 #素材';
    if (links.length) result += '\\n\\n来源：\\n' + links.map(link => '- ' + link).join('\\n');
    return { output_text: result, output: [{ type: 'message', content: [{ type: 'output_text', text: result }] }], choices: [{ message: { content: result } }], candidates: [{ content: { parts: [{ text: result }] } }], content: [{ type: 'text', text: result }] };
  }
  function memosResult(route, method, body, params) {
    if (route === 'auth/me' || route === 'auth/sessions/current') return { user: { name: 'users/preview', username: 'preview', displayName: '本地预览' } };
    if (route === 'instance/profile') return { version: '26.11.1' };
    if (route === 'memos' && method === 'GET') {
      const filter = params.get('filter') || '', keyword = filter.match(/content\\.contains\\(("(?:\\\\.|[^"\\\\])*")\\)/);
      const tag = filter.match(/("(?:\\\\.|[^"\\\\])*") in tags/);
      return { memos: Array.from(preview.memos.values()).filter(m => m.state !== 'ARCHIVED' &&
        (!keyword || m.content.includes(JSON.parse(keyword[1]))) && (!tag || m.tags?.includes(JSON.parse(tag[1])))), nextPageToken:'' };
    }
    if (route === 'memos' && method === 'POST') {
      if (preview.failSave) { preview.failSave = false; throw { status: 429, message: '模拟保存失败：达到用量限制', details: [{ reason: 'QUOTA_EXCEEDED' }] }; }
      const memo = { ...body, name: 'memos/' + (params.get('memoId') || 'preview-' + Date.now()), creator: 'users/preview', createTime: new Date().toISOString(), tags: ['学习'], attachments: body.attachments || [] };
      preview.memos.set(memo.name, memo); return memo;
    }
    if (/^memos\\/[^/]+$/.test(route)) {
      const memo = preview.memos.get(route);
      if (!memo) throw { status:404, message:'找不到此笔记' };
      if (method === 'PATCH') Object.assign(memo, body);
      preview.memos.set(route, memo); return memo;
    }
    if (route === 'attachments' && method === 'POST') {
      const attachment = { name: 'attachments/preview-' + Date.now(), filename: body.filename, type: body.type || 'image/png', creator: 'users/preview' };
      preview.attachments.set(attachment.name, attachment); return attachment;
    }
    if (/^attachments\\/[^/]+$/.test(route)) return preview.attachments.get(route) || { name: route, filename: 'preview.png', type: 'image/png' };
    if (/^users\\/[^/]+\\/views$/.test(route)) return { memoViews: [] };
    if (route === 'spaces') return { spaces:[{ name:'spaces/reading', title:'阅读小组' }], nextPageToken: '' };
    throw { status: 404, message: '本地预览未模拟该接口：' + route };
  }
  $.ajax = function (options) {
    const deferred = $.Deferred();
    const url = new URL(options.url, location.href);
    const method = String(options.type || options.method || 'GET').toUpperCase();
    const match = url.pathname.match(/\\/api\\/(?:v1\\/)?(.*)$/);
    const ai = !match;
    preview.requests.push({ kind: ai ? 'ai' : 'memos', method, path: url.pathname });
    const xhr = deferred.promise();
    xhr.status = 0; xhr.statusText = '';
    xhr.getResponseHeader = name => String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
    let settled = false;
    const fail = failure => {
      settled = true; xhr.status = failure.status || 500; xhr.statusText = 'error';
      xhr.responseJSON = { message: failure.message || '本地模拟请求失败', details: failure.details || [] };
      xhr.responseText = JSON.stringify(xhr.responseJSON);
      if (options.error) options.error(xhr, 'error', xhr.responseJSON.message);
      deferred.reject(xhr, 'error', xhr.responseJSON.message);
    };
    const timer = setTimeout(() => {
      try {
        if (ai && preview.failAI) { preview.failAI = false; throw { status: 503, message: '模拟 AI 服务暂时不可用' }; }
        const body = bodyOf(options);
        const data = ai ? aiResult(body) : memosResult(match[1], method, body, url.searchParams);
        settled = true; xhr.status = 200; xhr.statusText = 'OK'; xhr.responseJSON = clone(data); xhr.responseText = JSON.stringify(data);
        if (options.success) options.success(clone(data), 'success', xhr);
        deferred.resolve(clone(data), 'success', xhr);
      } catch (failure) { fail(failure); }
    }, ai ? 850 : 120);
    xhr.abort = () => { if (!settled) { clearTimeout(timer); fail({ status: 0, message: '模拟请求已取消' }); } return xhr; };
    return xhr;
  };
})();`;
}

const previewStyle = `
html[data-view=popup]{margin:0 auto} #previewBanner{max-width:665px;margin-inline:auto!important}
#previewBanner{position:relative;margin:0 0 0.7rem;padding:0.6rem 0.7rem;border:1px solid #d6c69d;border-radius:0.4rem;background:#fff7dd;color:#654d17;font:12px/1.5 system-ui,sans-serif;}
#previewBanner strong{display:block;font-size:13px;}#previewBanner .preview-controls{display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.3rem;}
#previewBanner button{padding:0.18rem 0.4rem;border:1px solid #d6c69d;border-radius:0.25rem;background:#fffdf7;color:#654d17;cursor:pointer;font-size:11px;}
#previewStatus{display:block;margin-top:0.3rem;overflow-wrap:anywhere;}
`;

function createPreviewServer() {
  return http.createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
    };
    function respond(status, type, value) { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(req.method === 'HEAD' ? '' : value); }
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) return respond(403, 'text/plain; charset=utf-8', 'Loopback preview only');
      if (req.method !== 'GET' && req.method !== 'HEAD') return respond(405, 'text/plain; charset=utf-8', 'Read-only preview server');
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (pathname === '/favicon.ico') { res.writeHead(204, headers); res.end(); return; }
      if (pathname === '/__preview-chrome.js') {
        const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales/zh_CN/messages.json'), 'utf8'));
        return respond(200, contentTypes['.js'], chromeRuntime(messages));
      }
      if (pathname === '/__preview-ajax.js') return respond(200, contentTypes['.js'], ajaxRuntime());
      if (pathname === '/__preview-style.css') return respond(200, contentTypes['.css'], previewStyle);
      if (pathname === '/panel.html') return respond(200, contentTypes['.html'], fs.readFileSync(path.join(root, 'panel.html'), 'utf8'));
      if (['/', '/popup.html', '/options.html'].includes(pathname)) {
        let html = fs.readFileSync(path.join(root, pathname === '/options.html' ? 'options.html' : 'popup.html'), 'utf8');
        html = html.replace(/<head>/i, '<head>\n<script src="/__preview-chrome.js"></script>\n<link rel="stylesheet" href="/__preview-style.css">');
        html = html.replace(/<title>[^<]*<\/title>/i, '<title>AI-MEMOS 本地预览（模拟数据）</title>');
        html = html.replace(/(<body\b[^>]*>)/i, '$1\n<aside id="previewBanner" aria-label="本地模拟环境"><strong>AI-MEMOS 本地预览 · 仅模拟数据</strong>不会连接真实 Memos 或 AI 服务，也不会读取 Chrome 扩展配置。<div class="preview-controls"><button type="button" id="previewReset">重置模拟数据</button><button type="button" id="previewFailAI">模拟下次 AI 失败</button><button type="button" id="previewFailSave">模拟下次保存失败</button></div><span id="previewStatus" role="status">所有服务请求均在本页模拟，外网请求已阻止。</span></aside>');
        const jquery = /(<script\b[^>]*src=["']js\/jquery\.min\.js["'][^>]*><\/script>)/i;
        if (!jquery.test(html)) throw new Error('Unable to locate popup jQuery script for isolated mocks');
        html = html.replace(jquery, '$1\n<script src="/__preview-ajax.js"></script>');
        return respond(200, contentTypes['.html'], html);
      }
      if (!/^\/(js|css|assets|_locales)\//.test(pathname)) return respond(404, 'text/plain; charset=utf-8', 'Preview resource not found');
      const file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep)) return respond(403, 'text/plain; charset=utf-8', 'Invalid resource path');
      const type = contentTypes[path.extname(file).toLowerCase()];
      if (!type) return respond(404, 'text/plain; charset=utf-8', 'Unsupported preview resource');
      const real = await fs.promises.realpath(file);
      if (!real.startsWith(root + path.sep)) return respond(403, 'text/plain; charset=utf-8', 'Linked resources outside the project are blocked');
      const data = await fs.promises.readFile(real);
      respond(200, type, data);
    } catch (error) {
      const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
      respond(missing ? 404 : 400, 'text/plain; charset=utf-8', missing ? 'Preview resource not found' : 'Invalid preview request');
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4311);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
  const server = createPreviewServer();
  server.on('error', error => { console.error('Preview server failed:', error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log('AI-MEMOS isolated preview: http://127.0.0.1:' + server.address().port + '/popup.html'));
}

module.exports = { createPreviewServer, chromeRuntime, ajaxRuntime };
