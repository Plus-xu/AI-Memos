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

function loadApi(
  responder = () => {
    throw new Error('Unexpected API request');
  },
  fetcher
) {
  const calls = [];
  class TestURL extends URL {}
  const context = vm.createContext({
    URL: TestURL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Blob,
    console: { error() {} },
    fetch:
      fetcher ||
      (() => {
        throw new Error('Unexpected file request');
      }),
    $: {
      ajax(options) {
        calls.push(options);
        return Promise.resolve().then(() => responder(options));
      }
    }
  });
  vm.runInContext(
    fs.readFileSync(path.join(root, 'js/memos-api.js'), 'utf8') + '\nglobalThis.api = MemosAPI;',
    context
  );
  return { api: context.api, context, calls };
}

test('26.11 workflow: validate, upload, bind an inline image, create, and archive', async () => {
  const { api, calls } = loadApi(options => {
    const url = new URL(options.url);
    assert.ok(url.pathname.startsWith('/api/'));
    assert.ok(!url.pathname.startsWith('/api/v1/'));
    assert.equal(options.headers.Authorization, 'Bearer test-pat');
    switch (url.pathname) {
      case '/api/auth/me':
        return { user: { name: 'users/tester' } };
      case '/api/instance/profile':
        return { version: '26.11.0' };
      case '/api/attachments': {
        const body = JSON.parse(options.data);
        assert.deepEqual(body, { filename: 'photo.png', type: 'image/png', content: 'AA==' });
        return { name: 'attachments/photo', filename: 'photo.png', type: 'image/png' };
      }
      case '/api/attachments/photo':
        return { name: 'attachments/photo', type: 'image/png' };
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
      default:
        throw new Error('Unexpected route: ' + url.pathname);
    }
  });
  assert.equal((await api.currentUser(info.apiUrl, info.apiTokens)).userName, 'users/tester');
  assert.equal((await api.getInstanceProfile(info)).version, '26.11.0');
  const attachment = await api.uploadAttachment(info, {
    filename: 'photo.png',
    type: 'image/png',
    content: 'AA==',
    visibility: 'PRIVATE'
  });
  const body = await api.prepareMemo(info, {
    content: '![photo](' + api.buildFileUrl(info.apiUrl, attachment) + ')',
    visibility: 'PRIVATE'
  });
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
  assert.deepEqual(
    calls.map(call => new URL(call.url).pathname),
    ['/api/auth/me', '/api/v1/auth/me', '/api/v1/auth/me', '/api/v1/auth/me', '/api/auth/me']
  );
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
  for (const failure of [
    refused(401),
    refused(403),
    refused(429),
    refused(500),
    { status: 0, statusText: 'timeout' }
  ]) {
    const { api, calls } = loadApi(() => {
      throw failure;
    });
    await assert.rejects(
      api.createMemo(info, { content: 'keep me', visibility: 'PRIVATE' }),
      error => error === failure
    );
    assert.equal(calls.length, 1);
  }
  const { api, calls } = loadApi(() => {
    throw refused(401);
  });
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
    if (!next)
      return { memos: Array.from({ length: 1000 }, (_, i) => ({ name: 'memos/' + i })), nextPageToken: 'a+/=&b' };
    assert.equal(next, 'a+/=&b');
    return {
      memos: [
        { name: 'memos/999' },
        { name: 'memos/private', visibility: 'PRIVATE' },
        { name: 'memos/team', visibility: 'SPACE' }
      ]
    };
  });
  const memos = await api.listMemos(
    info,
    '?filter=' + encodeURIComponent('content.contains("hello")') + '&state=NORMAL'
  );
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
  assert.equal(
    api.managedFile('https://memos.example/sub/', '/file/attachments/photo/a.png').url,
    'https://memos.example/sub/file/attachments/photo/a.png'
  );
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
    '```md',
    '![example](/file/attachments/ignored/a.png)',
    '```'
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
  for (const url of [
    'https://foreign.example/file/attachments/photo/a.png',
    '//foreign.example/file/attachments/photo/a.png',
    'javascript:alert(1)',
    '/api/memos',
    '/file/attachments/photo/a.png?redirect=1'
  ]) {
    await assert.rejects(api.fetchAttachmentBlob(info, url), { code: 'invalid_attachment_url' });
  }
  assert.equal(fileCalls.length, 1, 'the PAT must never be sent to untrusted URLs');
});

test('invalid base URLs fail before any request', async () => {
  const { api, calls } = loadApi();
  for (const apiUrl of [
    '',
    'javascript:alert(1)',
    'https://user:password@memos.example',
    'https://memos.example/?token=value'
  ]) {
    await assert.rejects(api.currentUser(apiUrl, 'test'), { code: 'invalid_url' });
  }
  assert.equal(calls.length, 0);
});

async function loadPopup(overrides = {}, saved = {}) {
  const { api, context } = loadApi();
  const nodes = new Map();
  const handlers = new Map();
  const messages = [];
  const storage = { ...info, memo_lock: 'PRIVATE', open_action: 'save_text', open_content: 'draft text', ...saved };
  const ready = [];
  const document = {
    documentElement: { lang: 'en' },
    addEventListener(event, fn) {
      if (event === 'DOMContentLoaded') ready.push(fn);
    },
    querySelectorAll: () => [],
    getElementById: id => node('#' + id)[0]
  };
  function node(selector) {
    if (selector === 'textarea[name=text]') selector = '#content';
    if (nodes.has(selector)) return nodes.get(selector);
    const element = {
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      focus() {},
      replaceChildren() {},
      add() {},
      setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      }
    };
    const wrapper = {
      0: element,
      attributes: {},
      properties: {},
      val(value) {
        if (value === undefined) return element.value;
        element.value = value;
        return this;
      },
      text(value) {
        if (value === undefined) return this.textValue || '';
        this.textValue = value;
        return this;
      },
      html(value) {
        this.htmlValue = value;
        return this;
      },
      attr(key, value) {
        if (value === undefined) return this.attributes[key];
        this.attributes[key] = value;
        return this;
      },
      removeAttr(key) {
        delete this.attributes[key];
        return this;
      },
      prop(key, value) {
        if (value === undefined) return this.properties[key];
        this.properties[key] = value;
        element[key] = value;
        return this;
      },
      on(event, delegated, fn) {
        handlers.set(selector + ':' + event + (typeof delegated === 'string' ? ':' + delegated : ''), fn || delegated);
        return this;
      },
      click(fn) {
        if (fn) handlers.set(selector + ':click', fn);
        else handlers.get(selector + ':click')?.();
        return this;
      },
      blur(fn) {
        handlers.set(selector + ':blur', fn);
        return this;
      }
    };
    for (const method of ['hide', 'show', 'slideDown', 'slideToggle', 'toggleClass', 'css', 'focus'])
      wrapper[method] = function () {
        return this;
      };
    nodes.set(selector, wrapper);
    return wrapper;
  }
  function $(selector) {
    return node(selector === document ? 'document' : selector);
  }
  $.message = message => messages.push(message.message);
  $.each = (values, callback) => values.forEach((value, index) => callback(index, value));
  Object.assign(
    api,
    {
      listSpaces: async () => [],
      getInstanceProfile: async () => ({ version: '0.31.0' }),
      prepareMemo: async (_, body) => body,
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body }),
      getMemo: async () => ({ name: 'memos/saved', content: 'saved' })
    },
    overrides
  );
  Object.assign(context, {
    $,
    MemosAPI: api,
    document,
    crypto: require('node:crypto').webcrypto,
    TextEncoder,
    uiMessage: key => key,
    Option: class {},
    AIReview: { isBusy: () => false, onMemoSaved() {}, refresh() {} },
    window: { addEventListener() {} },
    setTimeout() {},
    chrome: {
      runtime: { lastError: null },
      i18n: { getMessage: key => key },
      tabs: { query: async () => [] },
      storage: {
        onChanged: { addListener() {} },
        sync: {
          get(defaults, callback) {
            callback({ ...defaults, ...storage });
          },
          set(values, callback) {
            assert.ok(!Object.hasOwn(values, 'open_content'), 'draft text must not be written to sync storage');
            Object.assign(storage, plain(values));
            callback?.();
          }
        },
        local: {
          get(defaults, callback) {
            callback({
              ...defaults,
              ...Object.fromEntries(
                Object.keys(defaults)
                  .filter(key => Object.hasOwn(storage, key))
                  .map(key => [key, storage[key]])
              )
            });
          },
          set(values, callback) {
            Object.assign(storage, plain(values));
            callback?.();
          }
        }
      }
    }
  });
  for (const file of ['draft-storage', 'editor-draft', 'staged-files', 'memo-tags', 'workspace'])
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file + '.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/oper.js'), 'utf8'), context);
  ready.forEach(fn => fn());
  await flush();
  return { context, api, node, handlers, messages, storage, document };
}

test('failed memo saves preserve text and permit retry with the same draft', async () => {
  let attempts = 0;
  const popup = await loadPopup({
    createMemo: async (_, body) => {
      attempts++;
      assert.equal(body.content, 'draft text');
      if (attempts === 1) throw refused(429);
      return { name: 'memos/saved', ...body };
    }
  });
  await popup.context.sendText();
  assert.equal(popup.node('textarea[name=text]').val(), 'draft text');
  assert.equal(popup.storage.memosDraft.open_content, 'draft text');
  assert.equal(popup.context.memoSaveInProgress, false);
  await popup.context.sendText();
  assert.equal(attempts, 2);
  assert.equal(popup.storage.memosDraft.open_content, '');
});

test('a hidden tag after a URL fragment saves the memo as private', async () => {
  const bodies = [];
  const popup = await loadPopup(
    {
      createMemo: async (_, body) => {
        bodies.push(body);
        return { name: 'memos/saved', ...body };
      }
    },
    { hidetag: '私密', memo_lock: 'PUBLIC', open_content: '见 https://a.com/p#top 然后 #私密' }
  );
  await popup.context.sendText();
  assert.equal(bodies[0].visibility, 'PRIVATE');
});

test('repeated clicks cannot create duplicate memos and newer draft text survives a successful save', async () => {
  let complete;
  let posts = 0,
    started;
  const pending = new Promise(resolve => {
    started = resolve;
  });
  const popup = await loadPopup({
    createMemo: () => {
      posts++;
      started();
      return new Promise(resolve => {
        complete = resolve;
      });
    }
  });
  const first = popup.context.sendText();
  await popup.context.sendText();
  await pending;
  assert.equal(posts, 1);
  assert.equal(popup.node('textarea[name=text]').prop('readOnly'), true);
  popup.node('textarea[name=text]').val('newer AI edit');
  complete({ name: 'memos/saved', content: 'draft text' });
  await first;
  assert.equal(popup.storage.memosDraft.open_content, 'newer AI edit');
  assert.equal(popup.node('textarea[name=text]').prop('readOnly'), false);
});

test('pending uploads block save; upload failure keeps the existing draft', async () => {
  const popup = await loadPopup({
    uploadAttachment: async () => {
      throw refused(500);
    }
  });
  popup.context.pendingUploads = 1;
  popup.context.sendText();
  assert.equal(popup.context.memoSaveInProgress, false);
  assert.equal(popup.messages.at(-1), 'picUploading');
  popup.context.pendingUploads = 0;
  popup.context.StagedFiles.resolve = async () => {
    throw refused(500);
  };
  await popup.context.sendText();
  assert.equal(popup.storage.memosDraft.open_content, 'draft text');
  assert.equal(popup.storage.open_content, 'draft text');
});

test('popup search and random review use server permissions instead of visibility exclusions', async () => {
  const queries = [];
  const popup = await loadPopup({
    listMemoPage: async (_, query) => {
      queries.push(query);
      return { memos: [], next: '' };
    },
    listMemos: async (_, query) => {
      queries.push(query);
      return [];
    }
  });
  popup.node('#searchQuery').val('needle');
  popup.node('#searchTag').val('#reading');
  popup.document.getElementById('searchForm').onsubmit({ preventDefault() {} });
  await flush();
  popup.handlers.get('#random:click')();
  await flush();
  assert.equal(new URLSearchParams(queries[0]).get('filter'), 'content.contains("needle") && "reading" in tags');
  assert.equal(popup.node('#content').val(), 'draft text');
  assert.equal(queries[1], undefined);
});

test('private preview markup never embeds PATs or unsafe link protocols', async () => {
  const popup = await loadPopup();
  const html = popup.context.renderMarkdownPreview(
    '![private](/file/attachments/photo/a.png) [bad](javascript:evil) [safe](https://example.org/?a="quoted")',
    info
  );
  assert.ok(html.includes('data-memos-file="https://memos.example/file/attachments/photo/a.png"'));
  assert.ok(!html.includes('src="https://memos.example/file/'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes(info.apiTokens));
  assert.ok(html.includes('%22quoted%22'));
});

test('preview labels show escaped brackets and backslashes literally', async () => {
  const popup = await loadPopup();
  const html = popup.context.renderMarkdownPreview('[a\\[1\\]\\\\b](https://e.com)', info);
  assert.ok(html.includes('>a[1]\\b</a>'), html);
});

test('private image previews authenticate once, share a Blob URL and release it on clearing', async () => {
  let reads = 0;
  const revoked = [];
  const popup = await loadPopup({
    fetchAttachmentBlob: async () => {
      reads++;
      return new Blob(['image'], { type: 'image/png' });
    }
  });
  const images = Array.from({ length: 2 }, () => ({
    getAttribute: () => '/file/attachments/photo/a.png',
    removeAttribute() {}
  }));
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

test('quota and permission errors are distinct from invalid-token errors', async () => {
  const popup = await loadPopup();
  popup.context.showApiError('test', refused(403));
  assert.equal(popup.messages.at(-1), 'permissionDenied');
  popup.context.showApiError('test', { status: 429, responseJSON: { details: [{ reason: 'QUOTA_EXCEEDED' }] } });
  assert.equal(popup.messages.at(-1), 'quotaExceeded');
});

test('legacy drafts load, long drafts persist locally, and an empty local draft does not revive old synced text', async () => {
  const popup = await loadPopup({
    createMemo: async () => {
      throw refused(413);
    }
  });
  assert.equal(popup.node('textarea[name=text]').val(), 'draft text');
  const longDraft = '长草稿'.repeat(6000);
  popup.node('textarea[name=text]').val(longDraft);
  await popup.handlers.get('#content:input')();
  assert.equal(popup.storage.memosDraft.open_content, longDraft);
  await popup.context.sendText();
  const reopened = await loadPopup({}, { memosDraft: popup.storage.memosDraft });
  assert.equal(reopened.node('textarea[name=text]').val(), longDraft);
  await reopened.context.sendText();
  const empty = await loadPopup({}, { memosDraft: reopened.storage.memosDraft });
  assert.equal(empty.node('textarea[name=text]').val(), '');
  assert.equal(empty.storage.open_content, 'draft text', 'legacy text must not resurrect after a successful save');
});

test('the service worker appends context-menu captures with source to the popup draft', async () => {
  const popup = await loadPopup({}, { memosDraft: { open_action: 'save_text', open_content: 'existing\n' } });
  let onClicked;
  popup.context.importScripts = (...sources) => {
    for (const source of sources)
      vm.runInContext(fs.readFileSync(path.join(root, 'js', source), 'utf8'), popup.context);
  };
  popup.context.chrome.runtime.onInstalled = { addListener() {} };
  popup.context.chrome.contextMenus = {
    onClicked: {
      addListener(handler) {
        onClicked = handler;
      }
    }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'js/background.js'), 'utf8'), popup.context);
  onClicked(
    { menuItemId: 'Memos-send-selection', selectionText: 'captured text', pageUrl: 'https://example.org/article' },
    { title: 'Article' }
  );
  await flush();
  assert.ok(
    popup.storage.memosDraft.open_content.startsWith(
      'existing\n\n> captured text\n\n[Article](https://example.org/article)'
    )
  );
  const reopened = await loadPopup({}, { memosDraft: popup.storage.memosDraft });
  assert.equal(reopened.node('textarea[name=text]').val(), popup.storage.memosDraft.open_content);
});

test('visibility updates patch only the visibility field', async () => {
  const { api, calls } = loadApi(() => ({ name: 'memos/x', visibility: 'PRIVATE' }));
  await api.setMemoVisibility(info, 'memos/x', 'PRIVATE');
  const url = new URL(calls[0].url);
  assert.equal(calls[0].type, 'PATCH');
  assert.equal(url.pathname, '/api/memos/x');
  assert.equal(url.searchParams.get('updateMask'), 'visibility');
  assert.deepEqual(JSON.parse(calls[0].data), { visibility: 'PRIVATE' });
});

test('a saved memo whose server tags include the hidden tag but is not private offers a one-click fix', async () => {
  const patches = [];
  const popup = await loadPopup(
    {
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['secret'], visibility: 'PUBLIC' }),
      setMemoVisibility: async (_, name, visibility) => {
        patches.push([name, visibility]);
        return {};
      }
    },
    { hidetag: '#secret', memo_lock: 'PUBLIC' }
  );
  await popup.context.sendText();
  assert.equal(popup.node('#visibilityWarning')[0].hidden, false);
  await popup.context.makeSavedMemoPrivate();
  assert.deepEqual(patches, [['memos/saved', 'PRIVATE']]);
  assert.equal(popup.node('#visibilityWarning')[0].hidden, true);
  assert.equal(popup.messages.at(-1), 'madePrivate');
  await popup.context.makeSavedMemoPrivate();
  assert.equal(patches.length, 1);
});

test('the visibility warning stays when the fix fails and never appears for private or legacy responses', async () => {
  const failing = await loadPopup(
    {
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['secret'], visibility: 'PROTECTED' }),
      setMemoVisibility: async () => {
        throw refused(500);
      }
    },
    { hidetag: 'secret' }
  );
  await failing.context.sendText();
  await failing.context.makeSavedMemoPrivate();
  assert.equal(failing.node('#visibilityWarning')[0].hidden, false);
  for (const extra of [{ tags: ['secret'], visibility: 'PRIVATE' }, {}, { tags: ['other'], visibility: 'PUBLIC' }]) {
    const popup = await loadPopup(
      { createMemo: async (_, body) => ({ name: 'memos/saved', content: body.content, ...extra }) },
      { hidetag: 'secret' }
    );
    await popup.context.sendText();
    assert.equal(popup.node('#visibilityWarning')[0].hidden, true);
  }
});

async function searchedPopup(overrides = {}) {
  const calls = { restored: [], archived: [] };
  const popup = await loadPopup({
    listMemoPage: async (_, query) =>
      new URLSearchParams(query).get('pageToken')
        ? { memos: [{ name: 'memos/c', content: 'c' }], next: '' }
        : {
            memos: [
              { name: 'memos/a', content: 'a' },
              { name: 'memos/b', content: 'b' }
            ],
            next: 'p2'
          },
    archiveMemo: async (_, name) => {
      calls.archived.push(name);
      return {};
    },
    restoreMemo: async (_, name) => {
      calls.restored.push(name);
      return {};
    },
    ...overrides
  });
  popup.document.getElementById('searchForm').onsubmit({ preventDefault() {} });
  await flush();
  const shown = () =>
    (popup.node('#randomlist').htmlValue.match(/data-uid="[^"]+"/g) || []).map(value => value.slice(10, -1));
  return { popup, calls, shown };
}

test('restoring a memo patches only its state back to NORMAL', async () => {
  const { api, calls } = loadApi(() => ({}));
  await api.restoreMemo(info, 'memos/x');
  assert.equal(calls[0].type, 'PATCH');
  assert.equal(new URL(calls[0].url).searchParams.get('updateMask'), 'state');
  assert.deepEqual(JSON.parse(calls[0].data), { state: 'NORMAL' });
});

test('archiving removes one result, keeps pagination, and loading more never brings it back', async () => {
  const { popup, calls, shown } = await searchedPopup();
  assert.deepEqual(shown(), ['a', 'b']);
  await popup.context.archiveMemoByName('memos/a');
  assert.deepEqual(calls.archived, ['memos/a']);
  assert.deepEqual(shown(), ['b']);
  assert.equal(popup.document.getElementById('searchMore').hidden, false);
  assert.equal(popup.document.getElementById('archiveNotice').hidden, false);
  popup.document.getElementById('searchMore').onclick();
  await flush();
  assert.deepEqual(shown(), ['b', 'c']);
});

test('undoing an archive restores the memo on the server and at its place in the list', async () => {
  const { popup, calls, shown } = await searchedPopup();
  await popup.context.archiveMemoByName('memos/a');
  await popup.context.undoArchive();
  assert.deepEqual(calls.restored, ['memos/a']);
  assert.deepEqual(shown(), ['a', 'b']);
  assert.equal(popup.document.getElementById('archiveNotice').hidden, true);
  assert.equal(popup.messages.at(-1), 'archiveUndone');
  await popup.context.undoArchive();
  assert.equal(calls.restored.length, 1);
});

test('a failed undo leaves the archived memo out of the list and keeps the notice', async () => {
  const { popup, shown } = await searchedPopup({
    restoreMemo: async () => {
      throw refused(500);
    }
  });
  await popup.context.archiveMemoByName('memos/a');
  await popup.context.undoArchive();
  assert.deepEqual(shown(), ['b']);
  assert.equal(popup.document.getElementById('archiveNotice').hidden, false);
});

test('a failed archive leaves the list untouched; a new search drops the pending undo', async () => {
  const { popup, calls, shown } = await searchedPopup({
    archiveMemo: async () => {
      throw refused(500);
    }
  });
  await popup.context.archiveMemoByName('memos/a');
  assert.deepEqual(shown(), ['a', 'b']);
  const next = await searchedPopup();
  await next.popup.context.archiveMemoByName('memos/a');
  next.popup.document.getElementById('searchForm').onsubmit({ preventDefault() {} });
  await flush();
  assert.equal(next.popup.document.getElementById('archiveNotice').hidden, true);
  await next.popup.context.undoArchive();
  assert.deepEqual(next.calls.restored, []);
  assert.equal(calls.restored.length, 0);
});

test('archiving the single random memo empties the list and can be undone', async () => {
  const popup = await loadPopup({
    listMemos: async () => [{ name: 'memos/r', content: 'r' }],
    archiveMemo: async () => ({}),
    restoreMemo: async () => ({})
  });
  popup.handlers.get('#random:click')();
  await flush();
  assert.match(popup.node('#randomlist').htmlValue, /data-uid="r"/);
  await popup.context.archiveMemoByName('memos/r');
  assert.equal(popup.node('#randomlist').htmlValue, '');
  await popup.context.undoArchive();
  assert.match(popup.node('#randomlist').htmlValue, /data-uid="r"/);
});

test('relative times follow the interface language, including Japanese', async () => {
  const popup = await loadPopup();
  const now = Date.parse('2026-11-22T12:00:00Z');
  const ago = hours => new Date(now - hours * 3600e3).toISOString();
  const format = popup.context.relativeTime;
  assert.equal(format(ago(3), 'ja', now), '3 時間前');
  assert.equal(format(ago(3), 'zh-CN', now), '3小时前');
  assert.equal(format(ago(3), 'en', now), '3 hours ago');
  assert.equal(format(ago(48), 'en', now), '2 days ago');
  assert.equal(format(ago(0.5), 'en', now), '30 minutes ago');
  assert.equal(format(ago(24 * 400), 'en', now), '1 year ago');
  assert.equal(format(now - 3600e3, 'en', now), '1 hour ago');
  assert.equal(format('bad', 'en', now), '');
  assert.equal(format('', 'en', now), '');
  popup.document.documentElement.lang = 'ja';
  const html = popup.context.buildMemoHtml(info, {
    name: 'memos/a',
    content: 'x',
    createTime: new Date(Date.now() - 7200e3).toISOString()
  });
  assert.match(html, /2 時間前/);
});

test('the post-save check also recognises a child of the hidden tag', async () => {
  const popup = await loadPopup(
    { createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['work/secret'], visibility: 'PUBLIC' }) },
    { hidetag: 'work', memo_lock: 'PUBLIC' }
  );
  await popup.context.sendText();
  assert.equal(popup.node('#visibilityWarning')[0].hidden, false);
});

test('the post-save check covers every hidden tag in a multi-tag rule', async () => {
  const popup = await loadPopup(
    { createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['work'], visibility: 'PUBLIC' }) },
    { hidetag: 'diary, work', memo_lock: 'PUBLIC' }
  );
  await popup.context.sendText();
  assert.equal(popup.node('#visibilityWarning')[0].hidden, false);
});

test('undo and make-private do nothing after the account changes', async () => {
  const { popup, calls } = await searchedPopup();
  await popup.context.archiveMemoByName('memos/a');
  popup.storage.userName = 'someone-else';
  await popup.context.undoArchive();
  assert.deepEqual(calls.restored, []);
  assert.equal(popup.document.getElementById('archiveNotice').hidden, true);

  const patches = [];
  const saved = await loadPopup(
    {
      createMemo: async (_, body) => ({ name: 'memos/saved', ...body, tags: ['secret'], visibility: 'PUBLIC' }),
      setMemoVisibility: async (_, name) => {
        patches.push(name);
        return {};
      }
    },
    { hidetag: 'secret', memo_lock: 'PUBLIC' }
  );
  await saved.context.sendText();
  saved.storage.apiUrl = 'https://other.example/';
  await saved.context.makeSavedMemoPrivate();
  assert.deepEqual(patches, []);
  assert.equal(saved.node('#visibilityWarning')[0].hidden, true);
});

test('a double-clicked archive sends one request and can still be undone', async () => {
  const { popup, calls, shown } = await searchedPopup();
  await Promise.all([popup.context.archiveMemoByName('memos/a'), popup.context.archiveMemoByName('memos/a')]);
  assert.deepEqual(calls.archived, ['memos/a']);
  await popup.context.undoArchive();
  assert.deepEqual(shown(), ['a', 'b']);
});

test('a late random memo never replaces newer search results', async () => {
  let deliver;
  const { popup, shown } = await searchedPopup({
    listMemos: () =>
      new Promise(resolve => {
        deliver = resolve;
      })
  });
  popup.handlers.get('#random:click')();
  await flush();
  popup.document.getElementById('searchForm').onsubmit({ preventDefault() {} });
  await flush();
  deliver([{ name: 'memos/r', content: 'r' }]);
  await flush();
  assert.deepEqual(shown(), ['a', 'b']);
});

test('relative times say "now" for the present and small clock skew, and keep real future times', async () => {
  const popup = await loadPopup();
  const now = Date.parse('2026-11-22T12:00:00Z');
  const format = popup.context.relativeTime;
  assert.equal(format(now, 'en', now), 'now');
  assert.equal(format(now + 30e3, 'en', now), 'now');
  assert.equal(format(now, 'zh-CN', now), '现在');
  assert.equal(format(now, 'ja', now), '今');
  assert.equal(format(now - 5e3, 'en', now), '5 seconds ago');
  assert.equal(format(now + 3 * 3600e3, 'en', now), 'in 3 hours');
});
