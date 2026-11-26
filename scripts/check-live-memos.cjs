// Optional browser acceptance against an official Memos binary and an empty temporary database.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');

async function checkLiveMemos({ context, ext, fixture, waitFor, pass }) {
  const expected = process.env.MEMOS_VERSION || '26.11.1';
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port,
    tmp = path.resolve(os.tmpdir());
  const data = await fs.mkdtemp(path.join(tmp, 'ai-memos-test-db-'));
  const service = spawn(
    process.env.MEMOS_BINARY,
    [
      '--addr',
      '127.0.0.1',
      '--port',
      String(port),
      '--driver',
      'sqlite',
      '--data',
      data,
      '--config-apply',
      'off',
      '--instance-url=',
      '--log-level',
      'error'
    ],
    { cwd: data, windowsHide: true, stdio: 'ignore' }
  );
  const exit = once(service, 'exit').catch(() => {});
  const prefix = base + '/api/';
  async function call(route, body, token) {
    const response = await fetch(prefix + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('Memos ' + route.split('?')[0] + ' returned ' + response.status);
    return response.json();
  }
  try {
    let profile;
    for (let i = 0; i < 80; i++) {
      if (service.exitCode !== null) throw new Error('Local test server exited before startup');
      try {
        profile = await call('instance/profile');
        break;
      } catch (_) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    assert.equal(profile?.version, expected);
    assert.ok(!profile.instanceUrl);
    const credentials = { username: 'clipper-test', password: 'qa-' + randomUUID() };
    const user = await call('users', credentials);
    const login = await call('auth/signin', { passwordCredentials: credentials });
    const { token } = await call(
      user.name + '/personalAccessTokens',
      { description: 'Disposable browser check', expiresInDays: 1 },
      login.accessToken
    );
    assert.ok(token);
    const space = await call('spaces', { title: '阅读小组' }, token);
    const options = await context.newPage();
    await options.goto(ext + '/options.html');
    await waitFor(options, () => !!document.getElementById('apiUrl').value);
    await options.fill('#apiUrl', base);
    await options.fill('#apiTokens', token);
    await options.click('#saveKey');
    await waitFor(
      options,
      version =>
        document.getElementById('connectionStatus').textContent.includes('clipper-test') &&
        document.getElementById('connectionStatus').textContent.includes(version),
      expected
    );
    pass('The released Memos ' + expected + ' binary accepts the extension connection with a real temporary PAT');
    const page = await context.newPage();
    await page.goto(ext + '/panel.html');
    await waitFor(
      page,
      name =>
        !!document.querySelector('#memoSpace option[value="' + name + '"]') &&
        !document.getElementById('content').readOnly,
      space.name
    );
    await page.selectOption('#memoSpace', space.name);
    await page.selectOption('#visibility', 'SPACE');
    await page.fill('#content', '阅读室开放时间 #阅读\n');
    const article = await context.newPage();
    await article.goto(fixture.base + '/article');
    await article.bringToFront();
    await page.evaluate(() => document.getElementById('capturePage').click());
    await waitFor(page, () => document.getElementById('content').value.includes('[![阅读室照片](memos-local://'));
    await article.close();
    assert.equal((await call('memos', null, token)).memos.length, 0);
    const before = await call('attachments', null, token);
    assert.equal(before.attachments.length, 0);
    await page.click('#content_submit_text');
    await waitFor(
      page,
      () => !document.getElementById('saveStatus').hidden && !document.getElementById('content').value
    );
    const saved = (await call('memos', null, token)).memos;
    assert.equal(saved.length, 1);
    const memo = await call(saved[0].name, null, token);
    assert.equal(memo.space, space.name);
    assert.equal(memo.visibility, 'SPACE');
    assert.equal(memo.attachments.length, 1);
    const [attachment] = memo.attachments;
    assert.equal(attachment.memo, memo.name);
    assert.equal(attachment.filename, 'image (1).png');
    const imagePath = '/file/' + attachment.name;
    assert.ok(memo.content.includes('[![阅读室照片](' + imagePath + ')](' + fixture.base + '/notes)'));
    assert.ok(!memo.content.includes('memos-local://'));
    pass('The real server without an instance URL binds the clipped linked image on explicit save');
    const fileUrl = new URL(imagePath, base);
    const authenticated = await fetch(fileUrl, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' });
    assert.equal(authenticated.status, 200);
    const original = Buffer.from(await (await fetch(fixture.base + fixture.imagePath)).arrayBuffer());
    assert.ok(original.equals(Buffer.from(await authenticated.arrayBuffer())));
    const anonymous = await fetch(fileUrl, { redirect: 'manual' });
    assert.ok([401, 403, 404].includes(anonymous.status), 'Private attachment must require authorization');
    const previewReads = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === base && (url.pathname === imagePath || url.pathname.startsWith(imagePath + '/')))
        previewReads.push(url.pathname);
    });
    await page.click('[data-tab="search"]');
    await page.fill('#searchQuery', '阅读室');
    await page.fill('#searchTag', '#阅读');
    await page.click('#search');
    await waitFor(
      page,
      () =>
        document.querySelectorAll('#randomlist .random-item').length === 1 &&
        document.querySelector('#randomlist .random-content a img[src^="blob:"]')?.naturalWidth > 0 &&
        document.querySelector('#randomlist .random-item > img[src^="blob:"]')?.naturalWidth > 0
    );
    pass('Real keyword/tag search finds the members-only memo and the private image matches its original bytes');
    const linkedImage = page.locator('#randomlist .random-content a img');
    assert.equal(
      await linkedImage.getAttribute('src'),
      await page.locator('#randomlist .random-item > img').getAttribute('src')
    );
    assert.equal(previewReads.length, 1, 'The thumbnail and attachment share one authenticated download');
    const [gallery] = await Promise.all([context.waitForEvent('page', { timeout: 8000 }), linkedImage.click()]);
    await gallery.waitForURL(fixture.base + '/notes');
    await gallery.close();
    pass('Clicking the inline image opens its original link, and the attachment list reuses its Blob');
    await page.click('[data-tab="write"]');
    await page.click('#tags');
    await waitFor(page, () =>
      Array.from(document.querySelectorAll('#taglist .item-container'), tag => tag.textContent).includes('#阅读')
    );
    await page.click('#tags');
    await page.click('[data-tab="search"]');
    await page.click('#random');
    await waitFor(
      page,
      () =>
        document.querySelectorAll('#randomlist .random-item').length === 1 &&
        document.querySelector('#randomlist .random-content').textContent.includes('阅读室开放时间')
    );
    pass('The real server lists the saved tag from user statistics, and random review shows the saved memo');
    await page.click('.random-delete');
    await waitFor(page, () => document.getElementById('archiveNotice').hidden === false);
    assert.equal((await call(memo.name, null, token)).state, 'ARCHIVED');
    pass('Archiving the test memo updates its state on the real server');
    await page.click('#random');
    await waitFor(page, () => document.getElementById('searchStatus').textContent === uiMessage('noMemosFound'));
    assert.equal(await page.locator('#randomlist .random-item').count(), 0);
    pass('Random review does not bring the archived memo back');
  } finally {
    if (service.exitCode === null) service.kill();
    await exit;
    const resolved = await fs.realpath(data);
    // Never throw from here: it would replace the error that ended the check.
    if (
      path.dirname(resolved) === (await fs.realpath(tmp)) &&
      path.basename(resolved).startsWith('ai-memos-test-db-')
    ) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    } else {
      console.error('Unexpected test database path, left in place: ' + resolved);
      process.exitCode = 1;
    }
  }
}
module.exports = { checkLiveMemos };
