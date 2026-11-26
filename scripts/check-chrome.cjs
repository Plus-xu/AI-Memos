// Set CHROMIUM_PATH and PLAYWRIGHT_MODULE to use an existing Chromium for Testing installation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { startFixture } = require('./fixture-server.cjs');
const { createPreviewServer } = require('./preview-server.cjs');
const { once } = require('node:events');

async function waitFor(page, predicate, argument) {
  const deadline = Date.now() + 8500;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  const detail = await page.locator('#connectionStatus,#modelStatus,#effectiveVisibility,.tip').allTextContents();
  throw new Error(
    'Timed out waiting for ' + predicate.toString().slice(0, 180) + ' on ' + page.url() + ' — ' + detail.join(' / ')
  );
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const extension = path.resolve(process.env.EXTENSION_PATH || path.join(root, 'artifacts', 'qa-unpacked'));
  if (extension === root)
    throw new Error(
      'Use the unpacked release ZIP for browser checks. Chrome can remove reserved metadata from a loaded source tree.'
    );
  const output = path.resolve(
    root,
    'artifacts',
    'acceptance-' + JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'))).version
  );
  await fs.mkdir(output, { recursive: true });
  const fixture = await startFixture();
  let context;
  const checks = [],
    errors = [];
  const pass = name => {
    checks.push(name);
    console.log('PASS ' + name);
  };
  try {
    context = await chromium.launchPersistentContext('', {
      executablePath: process.env.CHROMIUM_PATH,
      channel: 'chromium',
      headless: true,
      viewport: { width: 920, height: 880 },
      args: [
        '--disable-extensions-except=' + extension,
        '--load-extension=' + extension,
        '--disable-background-networking',
        '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
      ]
    });
    context.setDefaultTimeout(7000);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 12000 }));
    const ext =
      new URL(worker.url()).origin === 'null'
        ? worker.url().split('/').slice(0, 3).join('/')
        : new URL(worker.url()).origin;
    assert.equal(
      await worker.evaluate(() => chrome.runtime.getManifest().version),
      JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'))).version
    );
    await worker.evaluate(() =>
      chrome.storage.sync.set({
        open_action: 'save_text',
        open_content: '升级前保存的本机测试草稿',
        llmProvider: 'openai',
        llmModel: 'gpt-4.1',
        llmApiKey: 'legacy-fixture',
        llmQuickPresets: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }]
      })
    );
    const legacy = await context.newPage();
    await legacy.goto(ext + '/popup.html');
    await waitFor(
      legacy,
      () =>
        !document.getElementById('content').readOnly &&
        document.getElementById('content').value === '升级前保存的本机测试草稿'
    );
    await legacy.fill('#content', '升级后的测试草稿');
    await waitFor(legacy, async () => (await DraftStorage.current()).open_content === '升级后的测试草稿');
    await legacy.reload();
    await waitFor(legacy, () => document.getElementById('content').value === '升级后的测试草稿');
    await legacy.fill('#content', '');
    await waitFor(legacy, async () => (await DraftStorage.current()).open_content === '');
    await legacy.close();
    // A Memos server or AI gateway behind a cookie-session access proxy depends on the site's cookies.
    await context.addCookies([{ name: 'proxy_session', value: 'fixture', url: fixture.base }]);
    const options = await context.newPage();
    await options.goto(ext + '/options.html');
    await waitFor(
      options,
      () => document.querySelector('#llmModel option') && document.querySelector('#languageSelect').value
    );
    await waitFor(
      options,
      () =>
        document.getElementById('llmModel').value === 'gpt-4.1' &&
        document.querySelector('.quick-preset-model')?.value === 'deepseek-v4-flash'
    );
    pass('An existing synced draft, model and shortcut preset survive an upgrade in a real browser profile');
    await options.selectOption('#languageSelect', 'zh_CN');
    await options.fill('#apiUrl', fixture.base);
    await options.fill('#apiTokens', 'fixture-pat');
    await options.click('#saveKey');
    await waitFor(options, () => document.getElementById('connectionStatus').innerText.includes('26.11.1'));
    assert.equal(await options.inputValue('#apiTokens'), '');
    await options.selectOption('#llmProvider', 'newapi');
    await options.fill('#llmBaseUrl', fixture.base);
    await options.fill('#llmApiKey', 'fixture-ai');
    await options.click('#refreshModels');
    await options.waitForSelector('#llmModel option[value="fixture-text"]', { state: 'attached' });
    assert.equal(await options.locator('#llmModel option[value*="embedding"]').count(), 0);
    await options.selectOption('#llmModel', 'fixture-text');
    await options.selectOption('#llmOutputLanguage', 'source');
    await options.click('#saveAI');
    await waitFor(options, () => !!document.getElementById('aiSettingsStatus').textContent);
    await options.reload();
    await waitFor(options, () => document.getElementById('llmModel').value === 'fixture-text');
    assert.match(fixture.calls.find(r => r.route === '/api/auth/me').cookie, /proxy_session=fixture/);
    pass('Options validate the Memos account, refresh gateway text models and restore the saved model');
    assert.equal(await options.inputValue('#llmOutputLanguage'), 'source');
    const languageChoices = await options.locator('#llmOutputLanguage option').allTextContents();
    assert.equal(languageChoices.length, 3);
    assert.ok(languageChoices.every(text => text.trim()));
    pass('The AI output language choice survives reopening the settings page');
    const page = await context.newPage();
    await page.setViewportSize({ width: 468, height: 635 });
    await page.goto(ext + '/popup.html');
    await waitFor(
      page,
      () =>
        !document.querySelector('#content').readOnly &&
        document.querySelector('#memoSpace option[value="spaces/reading"]')
    );
    await page.selectOption('#memoSpace', 'spaces/reading');
    await page.selectOption('#visibility', 'SPACE');
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 320, height: 710 });
    await panel.goto(ext + '/panel.html');
    await waitFor(
      panel,
      () =>
        document.documentElement.dataset.view === 'panel' &&
        !document.querySelector('#content').readOnly &&
        document.getElementById('visibility').value === 'SPACE'
    );
    const article = await context.newPage();
    await article.goto(fixture.base + '/article');
    await article.bringToFront();
    const capture = async (surface, action) => {
      // A native action popup reads the active article. Keep that tab active when driving a rendered extension page.
      await article.bringToFront();
      await surface.evaluate(id => document.getElementById(id).click(), action);
    };
    await capture(page, 'capturePage');
    await waitFor(page, () => document.getElementById('content').value.includes('open_at = 9'));
    assert.doesNotMatch(await page.inputValue('#content'), /Fixture navigation|Fixture footer/);
    assert.equal(fixture.attachments.size + fixture.memos.size, 0);
    await waitFor(panel, () => document.getElementById('content').value.includes('open_at = 9'));
    pass(
      'Article capture uses real isolated-world injection, strips page chrome, and mirrors the draft to a 320 px panel'
    );
    await article.evaluate(() => {
      const r = new Range();
      r.selectNodeContents(document.getElementById('selection'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    const first = await panel.inputValue('#content');
    await capture(panel, 'captureSelection');
    await waitFor(
      panel,
      original =>
        document.getElementById('content').value.length > original.length &&
        document.getElementById('content').value.includes('memos-local://'),
      first
    );
    const clipped = await panel.inputValue('#content');
    assert.match(clipped, /#+ 读者反馈/);
    assert.match(clipped, /\| 时段 \| 人数 \|/);
    assert.match(clipped, /- +延长周末开放时间/);
    assert.match(clipped, /\[来源说明\]\(http:\/\/127\.0\.0\.1:/);
    assert.match(clipped, /\[!\[阅读室照片\]\(memos-local:\/\/[a-f0-9-]{36}\)\]\(http:\/\/127\.0\.0\.1:\d+\/notes\)/);
    assert.equal(fixture.attachments.size + fixture.memos.size, 0);
    pass('Rich selection retains headings, lists, a table, links and a staged image without a server write');
    await waitFor(page, original => document.getElementById('content').value === original, clipped);
    await page.bringToFront();
    await page.locator('.shell').screenshot({ path: path.join(output, 'popup.png'), animations: 'disabled' });
    await panel.bringToFront();
    await panel.locator('.shell').screenshot({ path: path.join(output, 'panel.png'), animations: 'disabled' });
    await options.bringToFront();
    await options.selectOption('#themeSelect', 'dark');
    await waitFor(panel, () => document.documentElement.dataset.theme === 'dark');
    for (const [value, lang] of [
      ['ja', 'ja'],
      ['en', 'en'],
      ['zh_CN', 'zh-CN']
    ]) {
      await options.selectOption('#languageSelect', value);
      await waitFor(panel, expected => document.documentElement.lang === expected, lang);
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await panel.bringToFront();
    await panel.locator('.shell').screenshot({ path: path.join(output, 'panel-dark.png'), animations: 'disabled' });
    await options.bringToFront();
    await options.selectOption('#themeSelect', 'light');
    await waitFor(options, () => document.documentElement.dataset.theme === 'light');
    await options.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
    pass('Chinese, English, Japanese and the light/dark setting work across windows without horizontal overflow');
    await panel.bringToFront();
    await panel.evaluate(() => document.getElementById('ai_optimize').click());
    await panel.waitForSelector('#aiReviewPanel', { state: 'visible' });
    assert.equal(await panel.inputValue('#content'), clipped);
    await panel.fill('#aiReviewResult', '审阅后补充的摘要');
    await panel.click('#aiReviewAppend');
    await waitFor(page, () => document.querySelector('#content').value.endsWith('审阅后补充的摘要'));
    await page.bringToFront();
    await page.click('#aiUndo');
    await waitFor(panel, original => document.querySelector('#content').value === original, clipped);
    assert.match(fixture.calls.find(r => r.route === '/v1/chat/completions').cookie, /proxy_session=fixture/);
    pass('AI output can be edited, appended and undone from the other editor');
    // The fixture sends the first eight characters at once, two more soon after, and holds the rest back.
    const answer = '阅读室的周末开放时间是读者最关心的问题。';
    const privateDraft = clipped + '\n\n#ai-review-private';
    fixture.state.aiDelay = 6000;
    await worker.evaluate(() => chrome.storage.sync.set({ hidetag: 'ai-review-private' }));
    await panel.bringToFront();
    await panel.fill('#content', privateDraft);
    await waitFor(panel, () =>
      document.getElementById('effectiveVisibility').textContent.includes(uiMessage('lockPrivate'))
    );
    await panel.evaluate(() => document.getElementById('ai_optimize').click());
    await waitFor(
      panel,
      text =>
        document.getElementById('aiReviewResult').value.startsWith(text) && !document.getElementById('aiStop').hidden,
      answer.slice(0, 8)
    );
    assert.equal(await panel.evaluate(() => document.getElementById('aiReviewResult').readOnly), true);
    // What the reader selects in the text so far stays selected when more of it is drawn, and a selection
    // made backwards stays one.
    await panel.evaluate(() => document.getElementById('aiReviewResult').setSelectionRange(2, 6, 'backward'));
    // The other editor knows a generation is running, and has neither its text nor a way to stop it.
    await waitFor(page, () => AIReview.isBusy());
    assert.deepEqual(
      await page.evaluate(() => ['aiStop', 'aiReviewPanel'].map(id => document.getElementById(id).hidden)),
      [true, true]
    );
    // What arrives after the first text is drawn with a later frame, while the generation goes on.
    await waitFor(
      panel,
      text => document.getElementById('aiReviewResult').value === text && AIReview.isBusy(),
      answer.slice(0, 10)
    );
    assert.deepEqual(
      await panel.evaluate(() => {
        const box = document.getElementById('aiReviewResult');
        return [box.selectionStart, box.selectionEnd, box.selectionDirection];
      }),
      [2, 6, 'backward']
    );
    await panel.click('#aiStop');
    await waitFor(
      panel,
      async () =>
        !AIReview.isBusy() && (await chrome.storage.local.get('memosAIReview')).memosAIReview?.truncated === 'stopped'
    );
    assert.equal(await panel.inputValue('#content'), privateDraft);
    assert.equal(await panel.inputValue('#aiReviewResult'), answer.slice(0, 10));
    assert.deepEqual(
      await panel.evaluate(() => [
        document.getElementById('aiReviewWarning').textContent.includes(uiMessage('aiStoppedWarning')),
        document.getElementById('aiReviewWarning').hidden,
        document.getElementById('aiStop').hidden
      ]),
      [true, false, true]
    );
    pass('Stopping a generation leaves the draft unchanged and the partial result ready for review');
    await panel.click('#aiReviewReplace');
    await panel.waitForSelector('#aiVisibilityConfirmation', { state: 'visible' });
    assert.equal(
      await panel.textContent('#aiVisibilityChange'),
      await panel.evaluate(() =>
        uiMessage('aiVisibilityChange')
          .replace('{before}', uiMessage('lockPrivate'))
          .replace('{after}', uiMessage('lockSpace'))
      )
    );
    assert.equal(await panel.inputValue('#content'), privateDraft);
    await panel.click('#aiCancelAdoption');
    assert.equal(await panel.inputValue('#content'), privateDraft);
    // The later save uses this capture's sources to verify duplicate detection.
    const editedResult = answer.slice(0, 10) + '\n\n' + clipped;
    await panel.fill('#aiReviewResult', editedResult);
    await panel.click('#aiReviewReplace');
    await panel.click('#aiConfirmAdoption');
    assert.equal(await panel.inputValue('#content'), editedResult);
    await panel.click('#aiUndo');
    assert.equal(await panel.inputValue('#content'), privateDraft);
    await worker.evaluate(() => chrome.storage.sync.remove('hidetag'));
    await panel.fill('#content', clipped);
    await waitFor(page, original => document.getElementById('content').value === original, clipped);
    fixture.state.aiDelay = 0;
    pass('Adopting a stopped result that broadens visibility requires confirmation and remains undoable');
    // A model or gateway that refuses to stream is asked again without the flag, and answers in one piece.
    const chatCalls = () => fixture.calls.filter(call => call.route === '/v1/chat/completions');
    const asked = chatCalls().length;
    fixture.state.refuseStream = true;
    await panel.evaluate(() => document.getElementById('ai_optimize').click());
    await waitFor(
      panel,
      async () => !AIReview.isBusy() && !!(await chrome.storage.local.get('memosAIReview')).memosAIReview
    );
    assert.deepEqual(
      chatCalls()
        .slice(asked)
        .map(call => call.body.stream),
      [true, undefined]
    );
    assert.equal(await panel.inputValue('#aiReviewResult'), answer);
    assert.equal(
      await panel.evaluate(async () => (await chrome.storage.local.get('memosAIReview')).memosAIReview.truncated),
      undefined
    );
    await panel.click('#aiReviewDiscard');
    fixture.state.refuseStream = false;
    pass('A gateway that refuses to stream still delivers its answer, asked again in one piece');
    await panel.bringToFront();
    fixture.state.spaces = [];
    await panel.click('#content_submit_text');
    await waitFor(panel, () =>
      document.getElementById('effectiveVisibility').textContent.includes(uiMessage('spaceUnavailable'))
    );
    assert.equal(await panel.inputValue('#content'), clipped);
    assert.equal(fixture.attachments.size + fixture.memos.size, 0);
    pass('Lost Space membership preserves the draft and prevents uploads or silent destination changes');
    fixture.state.spaces = [{ name: 'spaces/reading', title: '阅读小组' }];
    await panel.reload();
    await waitFor(
      panel,
      () =>
        !document.querySelector('#content').readOnly &&
        document.querySelector('#visibility').value === 'SPACE' &&
        !document.getElementById('effectiveVisibility').textContent
    );
    fixture.state.failUpload = true;
    await panel.click('#content_submit_text');
    await waitFor(
      panel,
      () =>
        !document.querySelector('#content_submit_text').disabled &&
        document.querySelector('.tip')?.textContent === uiMessage('uploadTooLarge')
    );
    assert.equal(await panel.inputValue('#content'), clipped);
    assert.equal(fixture.attachments.size + fixture.memos.size, 0);
    pass('Rejected uploads leave the image staged and the draft available for retry');
    fixture.state.loseReceipt = true;
    await panel.click('#content_submit_text');
    await waitFor(
      panel,
      () =>
        (!document.querySelector('#content_submit_text').disabled &&
          !!document.getElementById('content').value &&
          document.querySelector('.tip')?.textContent.includes('503')) ||
        document.querySelector('.tip')?.textContent.includes('lost after commit')
    );
    assert.equal(fixture.memos.size, 1);
    assert.equal(fixture.attachments.size, 1);
    await panel.focus('#content');
    await panel.keyboard.press('Control+Enter');
    await panel.evaluate(() => document.getElementById('content_submit_text').click());
    await waitFor(
      panel,
      () => !document.getElementById('saveStatus').hidden && !document.querySelector('#content').value
    );
    const memo = Array.from(fixture.memos.values())[0];
    assert.equal(memo.visibility, 'SPACE');
    assert.equal(memo.space, 'spaces/reading');
    assert.doesNotMatch(memo.content, /memos-local:\/\//);
    assert.ok(memo.content.includes('[![阅读室照片](/file/attachments/file-1)](' + fixture.base + '/notes)'));
    assert.deepEqual(memo.attachments, [{ name: 'attachments/file-1' }]);
    assert.equal(fixture.calls.filter(r => r.route === '/api/memos' && r.method === 'POST').length, 1);
    assert.equal(fixture.calls.filter(r => r.route === '/api/attachments' && r.method === 'POST').length, 2);
    pass('Retry after a lost receipt reuses the confirmed memo, binds its attachment once and clears the saved draft');
    await capture(panel, 'capturePage');
    await panel.waitForSelector('#duplicateNotice', { state: 'visible' });
    await panel.bringToFront();
    await panel.click('[data-tab="history"]');
    await panel.waitForSelector('#historyList article');
    assert.equal(await panel.locator('#historyList article').count(), 1);
    assert.equal(await panel.locator('#historyList article > a').getAttribute('href'), fixture.base + '/article');
    await panel.fill('#historyQuery', '不存在的标题');
    await waitFor(panel, () => !document.querySelector('#historyList article'));
    await panel.click('[data-tab="search"]');
    await panel.fill('#searchQuery', '阅读室');
    await panel.fill('#searchTag', '#阅读');
    await panel.click('#search');
    await panel.waitForSelector('#searchMore', { state: 'visible' });
    await panel.click('#searchMore');
    await waitFor(panel, () => document.querySelectorAll('#randomlist article').length === 2);
    const last = fixture.calls.filter(r => r.query.filter).at(-1);
    assert.equal(last.query.filter, 'content.contains("阅读室") && "阅读" in tags');
    assert.equal(last.query.pageToken, 'page=2/opaque');
    pass('History finds duplicate sources and server search combines keyword/tag filters with deduplicated pagination');
    const requests = test => fixture.calls.filter(test).length;
    const listings = () => requests(r => r.route === '/api/memos' && r.method === 'GET' && !r.query.filter);
    const fetches = () => requests(r => /^\/api\/memos\/[^/]+$/.test(r.route) && r.method === 'GET');
    const randomReview = async () => {
      const before = fetches();
      await panel.click('#random');
      for (let i = 0; i < 120 && fetches() === before; i++) await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(fetches(), before + 1, 'Random review fetches the one memo it shows');
      await waitFor(
        panel,
        () =>
          document.querySelectorAll('#randomlist article').length === 1 &&
          !document.getElementById('searchStatus').textContent
      );
    };
    await randomReview();
    await randomReview();
    assert.equal(listings(), 1, 'Two random reviews list the memos once');
    await panel.click('[data-tab="write"]');
    const draft = await panel.inputValue('#content');
    await panel.click('#tags');
    await waitFor(panel, () =>
      Array.from(document.querySelectorAll('#taglist .item-container'), tag => tag.textContent).includes('#阅读')
    );
    assert.equal(
      requests(r => r.route === '/api/users/reader:getStats'),
      1
    );
    const quiet = fixture.calls.length;
    await panel.click('#tags');
    await waitFor(panel, () => document.getElementById('taglist').hidden);
    await panel.click('#tags');
    await waitFor(panel, () => !!document.querySelector('#taglist .item-container'));
    await panel.click('#taglist .item-container');
    const tagged = await panel.inputValue('#content');
    assert.ok(tagged.includes('#阅读 ') && tagged.length === draft.length + 4, 'A clicked tag is inserted once');
    await panel.click('#tags');
    await waitFor(panel, () => document.getElementById('taglist').hidden);
    assert.equal(fixture.calls.length, quiet, 'Closing and reopening the tag list sends no request');
    assert.equal(listings(), 1, 'Tags come from the user statistics, not from another listing');
    await panel.fill('#content', draft);
    await waitFor(panel, async text => (await DraftStorage.current()).open_content === text, draft);
    fixture.state.spacesDelay = 1500;
    const replies = fixture.state.spaceReplies;
    await panel.reload();
    await waitFor(panel, () => !!document.querySelector('#memoSpace option[value="spaces/reading"]'));
    assert.equal(fixture.state.spaceReplies, replies, 'The remembered spaces are drawn before the server answers');
    for (let i = 0; i < 120 && fixture.state.spaceReplies === replies; i++)
      await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(fixture.state.spaceReplies, replies + 1);
    fixture.state.spacesDelay = 0;
    await waitFor(panel, () => !document.getElementById('content').readOnly);
    pass('Tags and random review reuse one index per account, and the destination is drawn from remembered spaces');
    const reopenWithLimit = async bytes => {
      fixture.state.uploadBytes = bytes;
      await panel.evaluate(() => chrome.storage.local.remove('memosUploadLimits'));
      await panel.reload();
      await waitFor(
        panel,
        async expected =>
          !document.getElementById('content').readOnly &&
          Object.values((await chrome.storage.local.get('memosUploadLimits')).memosUploadLimits || {})[0]?.bytes ===
            expected,
        bytes
      );
    };
    await reopenWithLimit(10);
    await panel.locator('#inFile').setInputFiles(path.join(extension, 'assets', 'logo_24x24.png'));
    await waitFor(panel, () => document.querySelector('.tip')?.textContent.includes('logo_24x24.png'));
    assert.equal(await panel.inputValue('#content'), draft);
    await panel.locator('#inFile').setInputFiles([
      { name: 'tiny.txt', mimeType: 'text/plain', buffer: Buffer.from('tiny') },
      {
        name: 'logo_24x24.png',
        mimeType: 'image/png',
        buffer: await fs.readFile(path.join(extension, 'assets', 'logo_24x24.png'))
      }
    ]);
    await waitFor(panel, () => document.getElementById('content').value.includes('[tiny.txt](memos-local://'));
    // The refusal must still be the message on screen once the smaller file has been added.
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.match(await panel.locator('.tip').textContent(), /logo_24x24\.png/);
    assert.doesNotMatch(await panel.inputValue('#content'), /logo_24x24/);
    await panel.fill('#content', draft);
    await waitFor(panel, async text => (await DraftStorage.current()).open_content === text, draft);
    await reopenWithLimit(33554432);
    assert.equal(await panel.inputValue('#content'), draft);
    pass('A file over the upload limit the server reports is refused by name, alone or among smaller files');
    await article.goto(fixture.base + '/short');
    await capture(page, 'capturePage');
    await waitFor(page, () => document.getElementById('content').value.includes('目录与索引'));
    pass('Short pages fall back to a description and source');
    fixture.state.aiDelay = 2000;
    await page.evaluate(() => document.getElementById('ai_optimize').click());
    await waitFor(
      page,
      () => !!document.querySelector('#aiTaskStatus') && !document.querySelector('#aiTaskStatus').hidden
    );
    await waitFor(page, async () => !!(await chrome.storage.local.get('memosAIJob')).memosAIJob);
    await page.close();
    await panel.click('[data-tab="write"]');
    await waitFor(panel, async () => !(await chrome.storage.local.get('memosAIJob')).memosAIJob && !AIReview.isBusy());
    assert.match(await panel.inputValue('#content'), /目录与索引/);
    pass('Closing an editor during AI generation releases the job and keeps the draft available in the other surface');
    await article.bringToFront();
    const shell = await context.newPage();
    await shell.goto(ext + '/popup.html');
    await waitFor(shell, () => !document.getElementById('content').readOnly);
    await shell.fill('#content', '共同原稿');
    await waitFor(panel, () => document.getElementById('content').value === '共同原稿');
    await panel.evaluate(() => {
      document.getElementById('content').value = '侧栏修订';
    });
    await shell.fill('#content', '弹窗修订');
    await waitFor(shell, async () => (await DraftStorage.current()).open_content === '弹窗修订');
    await panel.evaluate(() => document.getElementById('content').dispatchEvent(new Event('input', { bubbles: true })));
    await waitFor(
      panel,
      async () =>
        !document.getElementById('draftConflict').hidden &&
        !!(await chrome.storage.local.get('memosDraftConflict:panel'))['memosDraftConflict:panel']
    );
    await panel.reload();
    await waitFor(
      panel,
      () => !document.getElementById('draftConflict').hidden && document.getElementById('content').value === '侧栏修订'
    );
    await panel.bringToFront();
    await panel.click('#draftKeepBoth');
    await waitFor(shell, () => document.getElementById('content').value.includes('弹窗修订\n\n侧栏修订'));
    pass('Conflicting edits survive reopening and both versions can be kept');
    await article.goto(fixture.base + '/article');
    await article.bringToFront();
    const contextResult = await worker.evaluate(async imageUrl => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return capture(tab, 'image', { menuItemId: 'Memos-send-image', srcUrl: imageUrl, pageUrl: tab.url });
    }, fixture.base + fixture.imagePath);
    assert.equal(contextResult.source.url, fixture.base + '/article');
    await waitFor(shell, () => document.getElementById('content').value.includes('memos-local://'));
    assert.equal(fixture.memos.size, 1);
    pass('The context-menu image handler appends to the shared draft and makes no Memos write');
    await shell.bringToFront();
    await shell.click('#content_submit_text');
    await waitFor(
      shell,
      () => !document.getElementById('saveStatus').hidden && !document.getElementById('content').value
    );
    assert.equal(fixture.memos.size, 2);
    assert.equal(fixture.attachments.size, 2);
    const [firstMemo, secondMemo] = Array.from(fixture.memos.values());
    assert.notEqual(firstMemo.attachments[0].name, secondMemo.attachments[0].name);
    pass('Saving the same image to a different memo creates a separate binding');
    await shell.click('#openPanel');
    const nativePanels = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
    assert.ok(nativePanels.length, 'Expected the native Chrome side panel');
    pass('Chrome registered a native side panel after a user gesture');
    await article.bringToFront();
    await worker.evaluate(() => chrome.action.openPopup());
    const popups = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] }));
    assert.ok(
      popups.some(p => p.documentUrl?.endsWith('/popup.html')),
      'Expected the native Chrome action popup'
    );
    pass('The toolbar action opens the packaged popup in a native Chrome popup host');
    const server = createPreviewServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const preview = await context.newPage(),
        base = 'http://127.0.0.1:' + server.address().port;
      await preview.goto(base + '/popup.html');
      await waitFor(
        preview,
        () =>
          !document.getElementById('content').readOnly &&
          document.getElementById('content').value.includes('数字化治理')
      );
      await preview.click('#capturePage');
      await waitFor(preview, () => document.getElementById('content').value.includes('纠错机制'));
      await preview.goto(base + '/options.html');
      await waitFor(preview, () => document.getElementById('llmModel').value === 'gpt-6.2-sol');
      await preview.click('#refreshModels');
      await waitFor(preview, () => !!document.querySelector('option[value="preview-text"]'));
      await preview.goto(base + '/panel.html');
      await waitFor(
        preview,
        () =>
          document.documentElement.dataset.view === 'panel' &&
          document.getElementById('content').value.includes('纠错机制')
      );
      // The preview answers AI and Memos requests itself, with no real server behind them.
      await preview.evaluate(() => document.getElementById('ai_optimize').click());
      await waitFor(
        preview,
        () => !document.getElementById('aiReviewPanel').hidden && !!document.getElementById('aiReviewResult').value
      );
      await preview.click('#aiReviewDiscard');
      await preview.click('#content_submit_text');
      await waitFor(
        preview,
        () => !document.getElementById('saveStatus').hidden && !document.getElementById('content').value
      );
      await preview.close();
      pass('The independent development preview serves the popup, options and panel with local data');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (process.env.MEMOS_BINARY) {
      const { checkLiveMemos } = require('./check-live-memos.cjs');
      await checkLiveMemos({ context, ext, fixture, waitFor, pass });
    }
    assert.deepEqual(errors, []);
    pass('Extension pages emitted zero JavaScript errors');
    await fs.writeFile(
      path.join(output, 'browser.json'),
      JSON.stringify(
        {
          version: context.browser()?.version() || (await worker.evaluate(() => navigator.userAgent)),
          checks,
          sources: process.env.MEMOS_BINARY
            ? 'Local Memos ' +
              (process.env.MEMOS_VERSION || '26.11.1') +
              ' with disposable SQLite and PAT, plus loopback Memos and AI fixtures'
            : 'Loopback Memos and AI fixtures',
          requests: { memoCreates: fixture.memos.size, attachmentUploads: fixture.attachments.size }
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      'Fixture calls',
      fixture.calls.map(r => r.method + ' ' + r.route),
      'Page errors',
      errors
    );
    throw error;
  } finally {
    try {
      await context?.close();
    } finally {
      await fixture.close();
    }
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
