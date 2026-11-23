const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { root, plain, flush } = require('./helpers/scripts.cjs');
const { info, loadApi, loadPopup } = require('./helpers/environments.cjs');

const refused = status => ({ status, responseJSON: { message: 'refused' } });

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

const paths = calls => calls.map(call => new URL(call.url).pathname);

test('legacy API detection is remembered across pages and forgotten after a server upgrade', async () => {
  let upgraded = false;
  const local = {};
  const page = () =>
    loadApi(
      options => {
        const legacy = options.url.includes('/api/v1/');
        if (!upgraded && !legacy) throw refused(404);
        if (upgraded && legacy) throw refused(410);
        return { user: { name: 'users/tester' } };
      },
      undefined,
      local
    );
  const first = page();
  await first.api.currentUser(info.apiUrl, info.apiTokens);
  await first.api.currentUser(info.apiUrl, info.apiTokens);
  assert.deepEqual(paths(first.calls), ['/api/auth/me', '/api/v1/auth/me', '/api/v1/auth/me']);
  assert.deepEqual(local, { memosApiPrefixes: { 'https://memos.example/': 'api/v1/' } });
  const second = page();
  await second.api.currentUser(info.apiUrl, info.apiTokens);
  assert.deepEqual(paths(second.calls), ['/api/v1/auth/me'], 'a reopened page must not probe again');
  upgraded = true;
  await second.api.currentUser(info.apiUrl, info.apiTokens);
  await second.api.currentUser(info.apiUrl, info.apiTokens);
  assert.deepEqual(paths(second.calls), ['/api/v1/auth/me', '/api/v1/auth/me', '/api/auth/me', '/api/auth/me']);
  assert.deepEqual(local, { memosApiPrefixes: {} });
  const third = page();
  await third.api.currentUser(info.apiUrl, info.apiTokens);
  assert.deepEqual(paths(third.calls), ['/api/auth/me']);
});

test('a failed request, and a success on the default prefix, write nothing to storage', async () => {
  const failing = loadApi(() => {
    throw refused(404);
  });
  await assert.rejects(failing.api.getInstanceProfile(info));
  assert.deepEqual(failing.local, {});
  const modern = loadApi(() => ({ version: '26.11.2' }));
  await modern.api.getInstanceProfile(info);
  assert.deepEqual(modern.local, {});
});

test('a server remembered as legacy is not asked for spaces; any other server is', async () => {
  const legacy = loadApi(undefined, undefined, { memosApiPrefixes: { 'https://memos.example/': 'api/v1/' } });
  assert.deepEqual(plain(await legacy.api.listSpaces(info)), []);
  assert.equal(legacy.calls.length, 0);
  const other = loadApi(() => ({ spaces: [{ name: 'spaces/a', title: 'A' }] }), undefined, {
    memosApiPrefixes: { 'https://elsewhere.example/': 'api/v1/' }
  });
  assert.deepEqual(plain(await other.api.listSpaces(info)), [{ name: 'spaces/a', title: 'A' }]);
  assert.deepEqual(paths(other.calls), ['/api/spaces']);
});

test('requests still work when the remembered prefixes cannot be read, written, or understood', async () => {
  const legacy = options => {
    if (!options.url.includes('/api/v1/')) throw refused(404);
    return { user: { name: 'users/tester' } };
  };
  const broken = loadApi(legacy);
  broken.context.chrome.storage.local.get = broken.context.chrome.storage.local.set = () => {
    throw new Error('storage unavailable');
  };
  await broken.api.currentUser(info.apiUrl, info.apiTokens);
  await broken.api.currentUser(info.apiUrl, info.apiTokens);
  assert.deepEqual(paths(broken.calls), ['/api/auth/me', '/api/v1/auth/me', '/api/v1/auth/me']);
  for (const junk of ['api/v1/', null, { 'https://memos.example/': 'elsewhere/' }]) {
    const odd = loadApi(() => ({ user: { name: 'users/tester' } }), undefined, { memosApiPrefixes: junk });
    await odd.api.currentUser(info.apiUrl, info.apiTokens);
    assert.deepEqual(paths(odd.calls), ['/api/auth/me']);
  }
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
      error =>
        error.status === failure.status && (error.statusText === 'timeout') === (failure.statusText === 'timeout')
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

test('a recorded capture failure is announced when the popup opens, then cleared', async () => {
  const failed = await loadPopup({}, { memosCaptureError: 'clipContextFailed' });
  assert.deepEqual(failed.messages, ['clipContextFailed']);
  assert.ok(!Object.hasOwn(failed.storage, 'memosCaptureError'));
  const reopened = await loadPopup({}, failed.storage);
  assert.deepEqual(reopened.messages, []);
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

test('user tags come from the statistics of the signed-in user, without tags that count nothing', async () => {
  const { api, calls } = loadApi(() => ({
    name: 'users/tester/stats',
    tagCounts: { b: 2, 'a/child': 1, a: 1, gone: 0 }
  }));
  assert.deepEqual(plain(await api.userTags(info)), ['b', 'a/child', 'a']);
  assert.deepEqual(paths(calls), ['/api/users/tester:getStats']);
  assert.equal(calls[0].type, 'GET');
  const older = loadApi(() => ({ tagCount: { reading: 3 } }));
  assert.deepEqual(plain(await older.api.userTags(info)), ['reading']);
  const none = loadApi(() => ({ tagCounts: {} }));
  assert.deepEqual(plain(await none.api.userTags(info)), []);
});

test('user tags are null when the server has no usable statistics, and an error otherwise', async () => {
  for (const answer of [
    () => {
      throw refused(404);
    },
    () => {
      throw refused(400);
    },
    () => {
      throw refused(501);
    },
    () => ({ name: 'users/tester/stats' }),
    () => ({ tagCounts: ['a'] }),
    () => ({ tagCounts: 'a' }),
    () => null
  ]) {
    assert.equal(await loadApi(answer).api.userTags(info), null);
  }
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      loadApi(() => {
        throw refused(status);
      }).api.userTags(info),
      error => error.status === status
    );
  }
  for (const userName of ['', undefined, 'tester', 'users/a/b']) {
    const { api, calls } = loadApi();
    assert.equal(await api.userTags({ ...info, userName }), null);
    assert.equal(calls.length, 0);
  }
});

test('the upload limit is read from the usage of the signed-in user', async () => {
  const { api, calls } = loadApi(() => ({
    name: 'users/tester/usage',
    limits: { memoContentBytes: '8192', uploadBytes: '33554432' }
  }));
  assert.equal(await api.uploadLimit(info), 33554432);
  assert.deepEqual(paths(calls), ['/api/users/tester/usage']);
  assert.equal(await loadApi(() => ({ limits: { uploadBytes: 1048576 } })).api.uploadLimit(info), 1048576);
});

test('the upload limit is null when the server does not say, and an error otherwise', async () => {
  for (const answer of [
    () => {
      throw refused(404);
    },
    () => {
      throw refused(400);
    },
    () => ({ name: 'users/tester/usage' }),
    () => ({ limits: {} }),
    () => ({ limits: { uploadBytes: '0' } }),
    () => ({ limits: { uploadBytes: '-5' } }),
    () => ({ limits: { uploadBytes: 'abc' } }),
    () => ({ limits: { uploadBytes: '1.5' } }),
    () => null
  ]) {
    assert.equal(await loadApi(answer).api.uploadLimit(info), null);
  }
  for (const status of [401, 500]) {
    await assert.rejects(
      loadApi(() => {
        throw refused(status);
      }).api.uploadLimit(info),
      error => error.status === status
    );
  }
  const { api, calls } = loadApi();
  assert.equal(await api.uploadLimit({ ...info, userName: '' }), null);
  assert.equal(calls.length, 0);
});

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
    getMemo: async () => ({ name: 'memos/r', content: 'r' }),
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

const scope = JSON.stringify([info.apiUrl, info.userName]);
const reading = { name: 'spaces/reading', title: 'Reading' };
const team = { name: 'spaces/team', title: 'Team' };
const spaceOptions = popup => popup.document.getElementById('memoSpace').options.map(option => option.value);

/** A popup whose space request stays open until `answer` settles it. */
async function popupAwaitingSpaces(saved = {}, overrides = {}) {
  let answer;
  const pending = new Promise((resolve, reject) => {
    answer = { resolve, reject };
  });
  const popup = await loadPopup({ listSpaces: () => pending, ...overrides }, saved);
  return { popup, answer };
}

test('the destination is drawn from the remembered spaces before the server answers, then follows the answer', async () => {
  const { popup, answer } = await popupAwaitingSpaces({
    ['memosSpaces:' + scope]: { spaces: [reading] },
    ['memosDestination:' + scope]: { space: reading.name, visibility: 'SPACE' }
  });
  assert.deepEqual(spaceOptions(popup), ['', reading.name]);
  assert.equal(popup.document.getElementById('memoSpace').value, reading.name);
  assert.equal(popup.document.getElementById('effectiveVisibility').textContent, '');
  answer.resolve([reading, { ...team, description: 'not kept' }]);
  await flush();
  assert.deepEqual(spaceOptions(popup), ['', reading.name, team.name]);
  assert.deepEqual(popup.storage['memosSpaces:' + scope], { spaces: [reading, team] });
});

test('an unchanged space list is neither redrawn nor stored again', async () => {
  const { popup, answer } = await popupAwaitingSpaces({ ['memosSpaces:' + scope]: { spaces: [reading] } });
  const drawn = popup.document.getElementById('memoSpace').options;
  const stored = popup.storage['memosSpaces:' + scope];
  answer.resolve([{ ...reading, memberCount: 3 }]);
  await flush();
  assert.equal(popup.document.getElementById('memoSpace').options, drawn);
  assert.equal(popup.storage['memosSpaces:' + scope], stored);
});

test('with nothing remembered, the first answer is drawn and remembered; a server without spaces remembers none', async () => {
  const fresh = await loadPopup({ listSpaces: async () => [reading] });
  assert.deepEqual(spaceOptions(fresh), ['', reading.name]);
  assert.deepEqual(fresh.storage['memosSpaces:' + scope], { spaces: [reading] });
  const legacy = await loadPopup(
    {
      listSpaces: async () => {
        throw refused(404);
      }
    },
    { ['memosSpaces:' + scope]: { spaces: [reading] } }
  );
  assert.deepEqual(spaceOptions(legacy), ['']);
  assert.deepEqual(legacy.storage['memosSpaces:' + scope], { spaces: [] });
  assert.deepEqual(legacy.messages, []);
});

test('a failed space refresh keeps the remembered spaces and says the check failed', async () => {
  const { popup, answer } = await popupAwaitingSpaces({ ['memosSpaces:' + scope]: { spaces: [reading] } });
  answer.reject(refused(500));
  await flush();
  assert.deepEqual(spaceOptions(popup), ['', reading.name]);
  assert.deepEqual(popup.messages, ['spaceCheckFailed']);
  assert.deepEqual(popup.storage['memosSpaces:' + scope], { spaces: [reading] });
});

test('a remembered space the server no longer lists blocks the save and keeps the draft', async () => {
  const posts = [];
  const saved = {
    ['memosSpaces:' + scope]: { spaces: [reading] },
    ['memosDestination:' + scope]: { space: reading.name, visibility: 'SPACE' }
  };
  const createMemo = async (_, body) => {
    posts.push(body);
    return { name: 'memos/saved', ...body };
  };
  const removed = await loadPopup({ listSpaces: async () => [], createMemo }, saved);
  await removed.context.sendText();
  assert.deepEqual(posts, []);
  assert.equal(removed.messages.at(-1), 'spaceUnavailable');
  assert.equal(removed.node('#content').val(), 'draft text');

  // The refresh on opening failed, so the popup still shows the space; only the check at save time knows.
  let opened = false;
  const stale = await loadPopup(
    {
      listSpaces: async () => {
        if (opened) return [team];
        opened = true;
        throw refused(500);
      },
      createMemo
    },
    saved
  );
  assert.deepEqual(spaceOptions(stale), ['', reading.name]);
  await stale.context.sendText();
  assert.deepEqual(posts, []);
  assert.equal(stale.messages.at(-1), 'spaceUnavailable');
  assert.equal(stale.node('#content').val(), 'draft text');
  assert.equal(stale.storage.memosDraft.open_content, 'draft text');
  assert.deepEqual(stale.storage['memosSpaces:' + scope], { spaces: [team] });
});

test("another account's remembered spaces are never shown", async () => {
  const other = JSON.stringify([info.apiUrl, 'users/someone-else']);
  const { popup } = await popupAwaitingSpaces({ ['memosSpaces:' + other]: { spaces: [team] } });
  assert.deepEqual(spaceOptions(popup), ['']);
});

test('spaces show and a memo saves into one even when the space list cannot be remembered', async () => {
  const posts = [];
  const { popup, answer } = await popupAwaitingSpaces(
    { ['memosDestination:' + scope]: { space: reading.name, visibility: 'SPACE' } },
    {
      createMemo: async (_, body) => {
        posts.push(body);
        return { name: 'memos/saved', ...body };
      }
    }
  );
  const local = popup.context.chrome.storage.local;
  const set = local.set;
  local.set = (values, callback) => {
    if (Object.keys(values).some(key => key.startsWith('memosSpaces:'))) throw new Error('quota exceeded');
    set(values, callback);
  };
  answer.resolve([reading]);
  await flush();
  assert.deepEqual(spaceOptions(popup), ['', reading.name]);
  popup.context.MemosAPI.listSpaces = async () => [reading, team];
  await popup.context.sendText();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].space, reading.name);
  assert.equal(posts[0].visibility, 'SPACE');
});

test('remembered spaces that are not a list of space names are ignored', async () => {
  for (const junk of ['spaces/reading', { spaces: 'spaces/reading' }, { spaces: [{ name: 'users/x' }, null, 7] }]) {
    const { popup } = await popupAwaitingSpaces({ ['memosSpaces:' + scope]: junk });
    assert.deepEqual(spaceOptions(popup), [''], JSON.stringify(junk));
  }
});

/**
 * Search results whose memos each hold one private image, named after the memo. `images()` are the image
 * elements now in the list: an element lasts until the list is redrawn, and `sources` is every src it got.
 */
async function imagePopup(overrides = {}) {
  const reads = [],
    revoked = [];
  const memo = id => ({ name: 'memos/' + id, content: '![p](/file/attachments/' + id + '/p.png)' });
  const popup = await loadPopup({
    listMemoPage: async (_, query) =>
      new URLSearchParams(query).get('pageToken')
        ? { memos: [memo('c')], next: '' }
        : { memos: [memo('a'), memo('b')], next: 'p2' },
    fetchAttachmentBlob: async (_, url) => {
      reads.push(url.split('/').at(-2));
      return new Blob(['image'], { type: 'image/png' });
    },
    archiveMemo: async () => ({}),
    restoreMemo: async () => ({}),
    ...overrides
  });
  let created = 0;
  popup.context.URL.createObjectURL = () => 'blob:' + ++created;
  popup.context.URL.revokeObjectURL = url => revoked.push(url);
  const list = popup.node('#randomlist'),
    html = list.html;
  let elements = [],
    parsed = 0;
  list.html = function (value) {
    if (value !== undefined) {
      elements = [];
      parsed = 0;
    }
    return html.call(this, value);
  };
  popup.document.querySelectorAll = selector => {
    if (!selector.includes('img[data-memos-file]')) return [];
    const markup = list.html();
    for (const [, url] of markup.slice(parsed).matchAll(/<img[^>]* data-memos-file="([^"]+)"/g)) {
      const attributes = new Map([['data-memos-file', url]]);
      elements.push({
        id: url.split('/').at(-2),
        sources: [],
        getAttribute: name => attributes.get(name),
        removeAttribute: name => attributes.delete(name),
        has: name => attributes.has(name),
        set src(value) {
          this.sources.push(value);
        }
      });
    }
    parsed = markup.length;
    return elements.filter(element => element.has('data-memos-file'));
  };
  const search = async () => {
    popup.document.getElementById('searchForm').onsubmit({ preventDefault() {} });
    await flush();
  };
  await search();
  const summary = () => elements.map(element => element.id + ':' + element.sources.length).join(' ');
  return { popup, reads, revoked, search, images: () => elements, summary };
}

test('loading more keeps the first page and downloads only the new images', async () => {
  const { popup, reads, revoked, images, summary } = await imagePopup();
  assert.deepEqual(reads, ['a', 'b']);
  const first = images().slice();
  popup.document.getElementById('searchMore').onclick();
  await flush();
  assert.deepEqual(reads, ['a', 'b', 'c']);
  assert.equal(images()[0], first[0], 'the first page must stay in place');
  assert.equal(images()[1], first[1]);
  assert.equal(summary(), 'a:1 b:1 c:1');
  assert.deepEqual(revoked, []);
});

test('archiving and restoring a result redraws the list from the images already downloaded', async () => {
  const { popup, reads, revoked, summary } = await imagePopup();
  await popup.context.archiveMemoByName('memos/a');
  assert.equal(summary(), 'b:1');
  await popup.context.undoArchive();
  assert.equal(summary(), 'a:1 b:1');
  assert.deepEqual(reads, ['a', 'b']);
  assert.deepEqual(revoked, []);

  const single = await imagePopup({
    listMemoPage: async () => ({ memos: [{ name: 'memos/a', content: '![p](/file/attachments/a/p.png)' }], next: '' })
  });
  await single.popup.context.archiveMemoByName('memos/a');
  assert.equal(single.popup.node('#randomlist').html(), '');
  await single.popup.context.undoArchive();
  assert.equal(single.summary(), 'a:1');
  assert.deepEqual(single.reads, ['a']);
});

test('a new search releases every downloaded image and downloads again', async () => {
  const { reads, revoked, search, summary } = await imagePopup();
  await search();
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.deepEqual(reads, ['a', 'b', 'a', 'b']);
  assert.equal(summary(), 'a:1 b:1');
});

test('an image that failed to download is tried again on the next redraw', async () => {
  let failed = false;
  const reads = [];
  const { popup, images, summary } = await imagePopup({
    fetchAttachmentBlob: async (_, url) => {
      const id = url.split('/').at(-2);
      reads.push(id);
      if (id === 'a' && !failed) {
        failed = true;
        throw refused(500);
      }
      return new Blob(['image'], { type: 'image/png' });
    }
  });
  assert.equal(summary(), 'a:0 b:1');
  assert.equal(images()[0].alt, 'attachmentPreviewFailed');
  await popup.context.archiveMemoByName('memos/b');
  await flush();
  assert.deepEqual(reads, ['a', 'b', 'a']);
  assert.equal(summary(), 'a:1');
});

const MB = 1024 * 1024;
const file = (name, bytes = 'file-bytes', type = 'text/plain') => Object.assign(new Blob([bytes], { type }), { name });
/** A file too big to build in a test: staging must refuse it before reading anything but its size. */
const hugeFile = (name, size) => ({ name, size, type: 'application/zip' });

async function popupForFiles(saved = {}, overrides = {}) {
  const popup = await loadPopup(overrides, { open_content: '', ...saved });
  popup.context.uiMessage = key => (key === 'fileTooLarge' ? 'too large: {name} > {limit}' : key);
  popup.messages.length = 0;
  return popup;
}

test('a file over the limit is refused by name while the other chosen files are added', async () => {
  const popup = await popupForFiles();
  await popup.context.addFiles([file('a.txt'), hugeFile('big.zip', 30 * MB + 1), file('c.txt')]);
  const draft = popup.node('#content').val();
  assert.match(draft, /^\[a\.txt\]\(memos-local:\/\/[a-f0-9-]{36}\)\n\[c\.txt\]\(memos-local:\/\/[a-f0-9-]{36}\)$/);
  // A later message would replace the refusal on screen, so the refusal is the only one.
  assert.deepEqual(popup.messages, ['too large: big.zip > 30.0 MB']);
  assert.equal(popup.storage.memosDraft.open_content, draft);
  assert.equal(popup.context.pendingUploads, 0);
});

test('when every chosen file is over the limit the draft stays as it was', async () => {
  const popup = await popupForFiles({ open_content: 'draft text' });
  await popup.context.addFiles([hugeFile('one.zip', 31 * MB), hugeFile('two.zip', 40 * MB)]);
  assert.equal(popup.node('#content').val(), 'draft text');
  assert.deepEqual(popup.messages, ['too large: one.zip, two.zip > 30.0 MB']);
});

test('a refused file whose name looks like a placeholder is still named literally', async () => {
  const popup = await popupForFiles();
  await popup.context.addFiles([hugeFile('{limit}.zip', 31 * MB)]);
  assert.deepEqual(popup.messages, ['too large: {limit}.zip > 30.0 MB']);
});

test('the limit the server gave replaces the default, in both directions', async () => {
  const limits = bytes => ({ memosUploadLimits: { [scope]: { bytes, at: Date.now() } } });
  const small = await popupForFiles(limits(1.5 * MB), { uploadLimit: async () => 1.5 * MB });
  await small.context.addFiles([hugeFile('two.zip', 2 * MB)]);
  assert.deepEqual(small.messages, ['too large: two.zip > 1.5 MB']);
  const large = await popupForFiles(limits(64 * MB));
  await large.context.addFiles([file('ok.txt')]);
  assert.deepEqual(large.messages, ['fileStaged']);
  const exact = await popupForFiles(limits(10), { uploadLimit: async () => 10 });
  await exact.context.addFiles([file('ten.txt', '0123456789'), file('eleven.txt', '0123456789a')]);
  assert.match(exact.node('#content').val(), /^\[ten\.txt\]\([^)]+\)$/);
});

test('an opened popup asks the server for the upload limit once a day and remembers the answer', async () => {
  let asked = 0;
  const uploadLimit = async () => {
    asked++;
    return 8 * MB;
  };
  const first = await loadPopup({ uploadLimit });
  await flush();
  assert.equal(first.storage.memosUploadLimits[scope].bytes, 8 * MB);
  await loadPopup({ uploadLimit }, { memosUploadLimits: first.storage.memosUploadLimits });
  await flush();
  assert.equal(asked, 1);
  const stale = { [scope]: { bytes: 8 * MB, at: Date.now() - 86400001 } };
  await loadPopup({ uploadLimit }, { memosUploadLimits: stale });
  await flush();
  assert.equal(asked, 2);
  const offline = await loadPopup({ uploadLimit }, { apiTokens: '' });
  await flush();
  assert.equal(asked, 2, 'nothing is asked without a connection');
  assert.equal(offline.storage.memosUploadLimits, undefined);
});

test('before refusing a file the limit is asked for again, so a limit raised on the server applies at once', async () => {
  let asked = 0;
  const popup = await popupForFiles(
    { memosUploadLimits: { [scope]: { bytes: MB, at: Date.now() } } },
    {
      uploadLimit: async () => {
        asked++;
        return 64 * MB;
      }
    }
  );
  await popup.context.addFiles([file('small.txt')]);
  assert.equal(asked, 0, 'files within the remembered limit ask nothing');
  await popup.context.addFiles([file('two.bin', 'x'.repeat(2 * MB))]);
  assert.equal(asked, 1);
  assert.deepEqual(popup.messages, ['fileStaged', 'fileStaged']);
  assert.equal(popup.storage.memosUploadLimits[scope].bytes, 64 * MB);
  assert.match(popup.node('#content').val(), /\[two\.bin\]\(memos-local:/);
});

test('when the limit cannot be asked for again, the remembered one decides', async () => {
  const popup = await popupForFiles(
    { memosUploadLimits: { [scope]: { bytes: MB, at: Date.now() } } },
    { uploadLimit: async () => Promise.reject(refused(500)) }
  );
  await popup.context.addFiles([hugeFile('two.zip', 2 * MB)]);
  assert.deepEqual(popup.messages, ['too large: two.zip > 1.0 MB']);
  assert.equal(popup.storage.memosUploadLimits[scope].bytes, MB);
});

test('an upload the server refuses as too large makes the popup ask for the limit again', async () => {
  let asked = 0;
  const popup = await loadPopup(
    {
      uploadLimit: async () => {
        asked++;
        return 4 * MB;
      }
    },
    { memosUploadLimits: { [scope]: { bytes: 64 * MB, at: Date.now() } } }
  );
  popup.context.StagedFiles.resolve = async () => {
    throw refused(413);
  };
  await popup.context.sendText();
  await flush();
  assert.equal(popup.messages.at(-1), 'uploadTooLarge');
  assert.equal(asked, 1);
  assert.equal(popup.storage.memosUploadLimits[scope].bytes, 4 * MB);
  assert.equal(popup.node('#content').val(), 'draft text');
});
