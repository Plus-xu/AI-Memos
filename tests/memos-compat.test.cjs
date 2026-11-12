const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const info = { apiUrl: 'https://memos.example/', apiTokens: 'test-pat', userName: 'users/tester' };
const plain = value => JSON.parse(JSON.stringify(value));
const refused = status => ({ status, responseJSON: { message: 'refused' } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function loadApi(responder = () => { throw new Error('Unexpected API request'); }, fetcher) {
  const calls = [];
  class TestURL extends URL {}
  const context = vm.createContext({
    URL: TestURL, URLSearchParams, AbortController, AbortSignal, Blob,
    console: { error() {} },
    fetch: fetcher || (() => { throw new Error('Unexpected file request'); }),
    $: { ajax(options) {
      calls.push(options);
      return Promise.resolve().then(() => responder(options));
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/memos-api.js'), 'utf8') + '\nglobalThis.api = MemosAPI;', context);
  return { api: context.api, context, calls };
}

test('26.11 workflow: validate, upload, bind an inline image, create, and archive', async () => {
  const { api, calls } = loadApi(options => {
    const url = new URL(options.url);
    assert.ok(url.pathname.startsWith('/api/'));
    assert.ok(!url.pathname.startsWith('/api/v1/'));
    assert.equal(options.headers.Authorization, 'Bearer test-pat');
    switch (url.pathname) {
      case '/api/auth/me': return { user: { name: 'users/tester' } };
      case '/api/instance/profile': return { version: '26.11.0' };
      case '/api/attachments': {
        const body = JSON.parse(options.data);
        assert.deepEqual(body, { filename: 'photo.png', type: 'image/png', content: 'AA==' });
        return { name: 'attachments/photo', filename: 'photo.png', type: 'image/png' };
      }
      case '/api/attachments/photo': return { name: 'attachments/photo', type: 'image/png' };
      case '/api/memos': {
        assert.equal(options.type, 'POST');
        const body = JSON.parse(options.data);
        assert.deepEqual(body.attachments, [{ name: 'attachments/photo' }]);
        assert.equal(body.content, '![photo](/file/attachments/photo/photo.png)');
        return { name: 'memos/saved', ...body };
      }
      case '/api/memos/saved':
        assert.equal(options.type, 'PATCH');
        assert.equal(url.searchParams.get('updateMask'), 'state');
        assert.deepEqual(JSON.parse(options.data), { state: 'ARCHIVED' });
        return { name: 'memos/saved', state: 'ARCHIVED' };
      default: throw new Error('Unexpected route: ' + url.pathname);
    }
  });
  assert.equal((await api.currentUser(info.apiUrl, info.apiTokens)).userName, 'users/tester');
  assert.equal((await api.getInstanceProfile(info)).version, '26.11.0');
  const attachment = await api.uploadAttachment(info, { filename: 'photo.png', type: 'image/png', content: 'AA==', visibility: 'PRIVATE' });
  const body = await api.prepareMemo(info, { content: '![photo](' + api.buildFileUrl(info.apiUrl, attachment) + ')', visibility: 'PRIVATE' });
  const memo = await api.createMemo(info, body);
  await api.archiveMemo(info, memo.name);
  assert.equal(calls.length, 6);
});

test('legacy API detection is cached and switches after a server upgrade', async () => {
  let upgraded = false;
  const { api, calls } = loadApi(options => {
    const legacy = options.url.includes('/api/v1/');
    if (!upgraded && !legacy) throw refused(404);
    if (upgraded && legacy) throw refused(410);
    return { user: { name: 'users/tester' } };
  });
  await api.currentUser(info.apiUrl, info.apiTokens);
  await api.currentUser(info.apiUrl, info.apiTokens);
  upgraded = true;
  await api.currentUser(info.apiUrl, info.apiTokens);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
    '/api/auth/me', '/api/v1/auth/me', '/api/v1/auth/me', '/api/v1/auth/me', '/api/auth/me'
  ]);
});

test('an HTML SPA fallback is recognized without accepting it as an API response', async () => {
  const { api, calls } = loadApi(options => {
    if (!options.url.includes('/api/v1/')) {
      throw { status: 200, getResponseHeader: () => 'text/html; charset=utf-8' };
    }
    return { version: '0.29.1' };
  });
  assert.equal((await api.getInstanceProfile(info)).version, '0.29.1');
  assert.equal(calls.length, 2);
});

test('authentication errors, quota refusals, timeouts and uncertain writes are never replayed', async () => {
  for (const failure of [refused(401), refused(403), refused(429), refused(500), { status: 0, statusText: 'timeout' }]) {
    const { api, calls } = loadApi(() => { throw failure; });
    await assert.rejects(api.createMemo(info, { content: 'keep me', visibility: 'PRIVATE' }), error => error === failure);
    assert.equal(calls.length, 1);
  }
  const { api, calls } = loadApi(() => { throw refused(401); });
  await assert.rejects(api.currentUser(info.apiUrl, info.apiTokens));
  assert.equal(calls.length, 1, 'an invalid PAT must not fall back to another auth endpoint');
});

test('legacy session fallback is restricted to missing auth routes', async () => {
  const { api } = loadApi(options => {
    if (!options.url.endsWith('/api/v1/auth/sessions/current')) throw refused(404);
    return { user: { name: 'users/42' } };
  });
  assert.equal((await api.currentUser(info.apiUrl, info.apiTokens)).userId, '42');
});

test('all memo pages are read, preserving filters and opaque tokens', async () => {
  const { api, calls } = loadApi(options => {
    const params = new URL(options.url).searchParams;
    assert.equal(params.get('filter'), 'content.contains("hello")');
    assert.equal(params.get('state'), 'NORMAL');
    const next = params.get('pageToken');
    if (!next) return { memos: Array.from({ length: 1000 }, (_, i) => ({ name: 'memos/' + i })), nextPageToken: 'a+/=&b' };
    assert.equal(next, 'a+/=&b');
    return { memos: [{ name: 'memos/999' }, { name: 'memos/private', visibility: 'PRIVATE' }, { name: 'memos/team', visibility: 'SPACE' }] };
  });
  const memos = await api.listMemos(info, '?filter=' + encodeURIComponent('content.contains("hello")') + '&state=NORMAL');
  assert.equal(memos.length, 1002);
  assert.equal(memos.at(-1).visibility, 'SPACE');
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get('pageSize'), '1000');
});

test('repeated pagination tokens fail instead of looping or silently truncating', async () => {
  const { api, calls } = loadApi(() => ({ memos: [], nextPageToken: 'repeated' }));
  await assert.rejects(api.listMemos(info), { code: 'invalid_page_token' });
  assert.equal(calls.length, 2);
});

test('content filters escape CEL strings without excluding private or space memos', () => {
  const { api } = loadApi();
  const text = 'He said "yes" \\ path\n\t\r\b';
  const filter = api.buildContentFilter(text);
  assert.equal(filter, 'content.contains(' + JSON.stringify(text) + ')');
  assert.ok(!filter.includes('visibility'));
});

test('file URLs encode Unicode, spaces, query characters, quotes and Markdown parentheses', () => {
  const { api } = loadApi();
  const filename = "报告 [1] #?(').png";
  const url = api.buildFileUrl(info.apiUrl, { name: 'attachments/photo', filename });
  assert.equal(new URL(url).hash, '');
  assert.equal(new URL(url).search, '');
  assert.ok(!/[()']/.test(url));
  assert.equal(api.managedFile(info.apiUrl, url).filename, filename);
  assert.equal(api.managedFile('https://memos.example/sub/', '/file/attachments/photo/a.png').url, 'https://memos.example/sub/file/attachments/photo/a.png');
});

test('draft attachment binding is derived from references and survives reopening without hidden state', async () => {
  const metadata = {
    photo: { name: 'attachments/photo', type: 'image/png' },
    pdf: { name: 'attachments/pdf', type: 'application/pdf' },
    linked: { name: 'attachments/linked', memo: 'memos/older' }
  };
  const { api, calls } = loadApi(options => metadata[new URL(options.url).pathname.split('/').pop()]);
  const content = [
    '![one](' + info.apiUrl + 'file/attachments/photo/a.png)',
    '![two](/file/attachments/photo/a.png)',
    '[file](/file/attachments/pdf/a.pdf)',
    '[existing](/file/attachments/linked/a.pdf)',
    '![external](https://images.example/a.png)',
    '`![example](/file/attachments/ignored/a.png)`',
    '```md', '![example](/file/attachments/ignored/a.png)', '```'
  ].join('\n');
  const prepared = await api.prepareMemo(info, { content, visibility: 'PRIVATE' });
  assert.deepEqual(plain(prepared.attachments), [{ name: 'attachments/photo' }, { name: 'attachments/pdf' }]);
  assert.ok(prepared.content.startsWith('![one](/file/attachments/photo/a.png)'));
  assert.ok(prepared.content.includes('[existing](/file/attachments/linked/a.pdf)'));
  assert.ok(prepared.content.includes('`![example](/file/attachments/ignored/a.png)`'));
  assert.equal(calls.length, 3, 'duplicate references need only one metadata lookup');
  const reopened = loadApi(options => metadata[new URL(options.url).pathname.split('/').pop()]).api;
  assert.deepEqual(plain(await reopened.prepareMemo(info, { content, visibility: 'PRIVATE' })), plain(prepared));
  const noFiles = await api.prepareMemo(info, { content: 'ordinary note', visibility: 'PRIVATE' });
  assert.ok(!Object.hasOwn(noFiles, 'attachments'));
});

test('attachment reads authenticate only exact instance file routes and refuse redirects', async () => {
  const fileCalls = [];
  const { api } = loadApi(undefined, async (url, options) => {
    fileCalls.push({ url, options });
    return { ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) };
  });
  const blob = await api.fetchAttachmentBlob(info, '/file/attachments/photo/a.png');
  assert.equal(blob.type, 'image/png');
  assert.equal(fileCalls[0].options.headers.Authorization, 'Bearer test-pat');
  assert.equal(fileCalls[0].options.credentials, 'omit');
  assert.equal(fileCalls[0].options.redirect, 'error');
  for (const url of ['https://foreign.example/file/attachments/photo/a.png', '//foreign.example/file/attachments/photo/a.png', 'javascript:alert(1)', '/api/memos', '/file/attachments/photo/a.png?redirect=1']) {
    await assert.rejects(api.fetchAttachmentBlob(info, url), { code: 'invalid_attachment_url' });
  }
  assert.equal(fileCalls.length, 1, 'the PAT must never be sent to untrusted URLs');
});

test('invalid base URLs fail before any request', async () => {
  const { api, calls } = loadApi();
  for (const apiUrl of ['', 'javascript:alert(1)', 'https://user:password@memos.example', 'https://memos.example/?token=value']) {
    await assert.rejects(api.currentUser(apiUrl, 'test'), { code: 'invalid_url' });
  }
  assert.equal(calls.length, 0);
});

function loadPopup(overrides = {}, saved = {}) {
  const { api, context } = loadApi();
  const nodes = new Map();
  const handlers = new Map();
  const messages = [];
  const storage = { ...info, memo_lock: 'PRIVATE', open_action: 'save_text', open_content: 'draft text', ...saved };
  const document = { addEventListener() {}, querySelectorAll: () => [], getElementById: id => node('#' + id)[0] };
  function node(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const element = { value: '', selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
    const wrapper = {
      0: element, attributes: {}, properties: {},
      val(value) { if (value === undefined) return element.value; element.value = value; return this; },
      text(value) { if (value === undefined) return this.textValue || ''; this.textValue = value; return this; },
      html(value) { this.htmlValue = value; return this; },
      attr(key, value) { if (value === undefined) return this.attributes[key]; this.attributes[key] = value; return this; },
      removeAttr(key) { delete this.attributes[key]; return this; },
      prop(key, value) { if (value === undefined) return this.properties[key]; this.properties[key] = value; return this; },
      on(event, delegated, fn) { handlers.set(selector + ':' + event + (typeof delegated === 'string' ? ':' + delegated : ''), fn || delegated); return this; },
      click(fn) { if (fn) handlers.set(selector + ':click', fn); else handlers.get(selector + ':click')?.(); return this; },
      blur(fn) { handlers.set(selector + ':blur', fn); return this; }
    };
    for (const method of ['hide', 'show', 'slideDown', 'slideToggle', 'toggleClass', 'css', 'focus']) wrapper[method] = function () { return this; };
    nodes.set(selector, wrapper);
    return wrapper;
  }
  function $(selector) { return node(selector === document ? 'document' : selector); }
  $.message = message => messages.push(message.message);
  $.each = (values, callback) => values.forEach((value, index) => callback(index, value));
  const dayjs = () => ({ fromNow: () => 'now' });
  dayjs.extend = dayjs.locale = () => {};
  Object.assign(api, {
    prepareMemo: async (_, body) => body,
    createMemo: async (_, body) => ({ name: 'memos/saved', ...body }),
    getMemo: async () => ({ name: 'memos/saved', content: 'saved' })
  }, overrides);
  Object.assign(context, {
    $, MemosAPI: api, document, dayjs,
    window: { addEventListener() {} },
    setTimeout() {},
    chrome: {
      runtime: { lastError: null },
      i18n: { getMessage: key => key },
      storage: {
        sync: {
          get(defaults, callback) { callback({ ...defaults, ...storage }); },
          set(values, callback) {
            assert.ok(!Object.hasOwn(values, 'open_content'), 'draft text must not be written to sync storage');
            Object.assign(storage, plain(values)); callback?.();
          }
        },
        local: {
          get(defaults, callback) { callback({ ...defaults, memosDraft: storage.memosDraft || null }); },
          set(values, callback) { Object.assign(storage, plain(values)); callback?.(); }
        }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/draft-storage.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/oper.js'), 'utf8'), context);
  return { context, api, node, handlers, messages, storage, document };
}

test('failed memo saves preserve text and permit retry with the same draft', async () => {
  let attempts = 0;
  const popup = loadPopup({ createMemo: async (_, body) => {
    attempts++;
    assert.equal(body.content, 'draft text');
    if (attempts === 1) throw refused(429);
    return { name: 'memos/saved', ...body };
  } });
  popup.context.sendText();
  await flush();
  assert.equal(popup.node('textarea[name=text]').val(), 'draft text');
  assert.equal(popup.storage.memosDraft.open_content, 'draft text');
  assert.equal(popup.context.memoSaveInProgress, false);
  popup.context.sendText();
  await flush();
  assert.equal(attempts, 2);
  assert.equal(popup.storage.memosDraft.open_content, '');
});

test('repeated clicks cannot create duplicate memos and newer draft text survives a successful save', async () => {
  let complete;
  let posts = 0;
  const popup = loadPopup({ createMemo: () => { posts++; return new Promise(resolve => { complete = resolve; }); } });
  popup.context.sendText();
  popup.context.sendText();
  await flush();
  assert.equal(posts, 1);
  assert.equal(popup.node('textarea[name=text]').prop('readOnly'), true);
  popup.node('textarea[name=text]').val('newer AI edit');
  complete({ name: 'memos/saved', content: 'draft text' });
  await flush();
  assert.equal(popup.storage.memosDraft.open_content, 'newer AI edit');
  assert.equal(popup.node('textarea[name=text]').prop('readOnly'), false);
});

test('pending uploads block save; upload failure keeps the existing draft', async () => {
  const popup = loadPopup({ uploadAttachment: async () => { throw refused(500); } });
  popup.context.pendingUploads = 1;
  popup.context.sendText();
  assert.equal(popup.context.memoSaveInProgress, false);
  assert.equal(popup.messages.at(-1), 'picUploading');
  await assert.rejects(popup.context.uploadImageNow('AA==', { name: 'a.png', type: 'image/png' }));
  assert.equal(popup.storage.open_content, 'draft text');
});

test('popup search and random review use server permissions instead of visibility exclusions', async () => {
  const queries = [];
  const popup = loadPopup({ listMemos: async (_, query) => { queries.push(query); return []; } });
  popup.handlers.get('#search:click')();
  popup.handlers.get('#random:click')();
  await flush();
  assert.equal(new URLSearchParams(queries[0].slice(1)).get('filter'), 'content.contains("draft text")');
  assert.equal(queries[1], undefined);
});

test('private preview markup never embeds PATs or unsafe link protocols', () => {
  const popup = loadPopup();
  const html = popup.context.renderMarkdownPreview('![private](/file/attachments/photo/a.png) [bad](javascript:evil) [safe](https://example.org/?a="quoted")', info);
  assert.ok(html.includes('data-memos-file="https://memos.example/file/attachments/photo/a.png"'));
  assert.ok(!html.includes('src="https://memos.example/file/'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes(info.apiTokens));
  assert.ok(html.includes('%22quoted%22'));
});

test('private image previews authenticate once, share a Blob URL and release it on clearing', async () => {
  let reads = 0;
  const revoked = [];
  const popup = loadPopup({ fetchAttachmentBlob: async () => { reads++; return new Blob(['image'], { type: 'image/png' }); } });
  const images = Array.from({ length: 2 }, () => ({ getAttribute: () => '/file/attachments/photo/a.png', removeAttribute() {} }));
  popup.context.URL.createObjectURL = () => 'blob:test-preview';
  popup.context.URL.revokeObjectURL = url => revoked.push(url);
  popup.document.querySelectorAll = () => images;
  popup.context.hydrateMemoImages(info);
  await flush();
  assert.equal(reads, 1);
  assert.equal(images[0].src, 'blob:test-preview');
  assert.equal(images[1].src, 'blob:test-preview');
  popup.context.clearMemoList();
  assert.deepEqual(revoked, ['blob:test-preview']);
});

test('quota and permission errors are distinct from invalid-token errors', () => {
  const popup = loadPopup();
  popup.context.showApiError('test', refused(403));
  assert.equal(popup.messages.at(-1), 'permissionDenied');
  popup.context.showApiError('test', { status: 429, responseJSON: { details: [{ reason: 'QUOTA_EXCEEDED' }] } });
  assert.equal(popup.messages.at(-1), 'quotaExceeded');
});

test('legacy drafts load, long drafts persist locally, and an empty local draft does not revive old synced text', async () => {
  const popup = loadPopup({ createMemo: async () => { throw refused(413); } });
  assert.equal(popup.node('textarea[name=text]').val(), 'draft text');
  const longDraft = '长草稿'.repeat(6000);
  popup.node('textarea[name=text]').val(longDraft);
  popup.handlers.get('textarea[name=text]:input')();
  assert.equal(popup.storage.memosDraft.open_content, longDraft);
  popup.context.sendText();
  await flush();
  const reopened = loadPopup({}, { memosDraft: popup.storage.memosDraft });
  assert.equal(reopened.node('textarea[name=text]').val(), longDraft);
  reopened.context.sendText();
  await flush();
  const empty = loadPopup({}, { memosDraft: reopened.storage.memosDraft });
  assert.equal(empty.node('textarea[name=text]').val(), '');
  assert.equal(empty.storage.open_content, 'draft text', 'legacy text must not resurrect after a successful save');
});

test('the service worker appends context-menu captures with source to the popup draft', async () => {
  const popup = loadPopup({}, { memosDraft: { open_action: 'save_text', open_content: 'existing\n' } });
  let onClicked;
  popup.context.importScripts = (...sources) => {
    for (const source of sources) vm.runInContext(fs.readFileSync(path.join(root, 'js', source), 'utf8'), popup.context);
  };
  popup.context.chrome.runtime.onInstalled = { addListener() {} };
  popup.context.chrome.contextMenus = { onClicked: { addListener(handler) { onClicked = handler; } } };
  vm.runInContext(fs.readFileSync(path.join(root, 'js/background.js'), 'utf8'), popup.context);
  onClicked({ menuItemId: 'Memos-send-selection', selectionText: 'captured text', pageUrl: 'https://example.org/article' }, { title: 'Article' });
  await flush();
  assert.ok(popup.storage.memosDraft.open_content.startsWith('existing\n\n> captured text\n\n[Article](https://example.org/article)'));
  const reopened = loadPopup({}, { memosDraft: popup.storage.memosDraft });
  assert.equal(reopened.node('textarea[name=text]').val(), popup.storage.memosDraft.open_content);
});
