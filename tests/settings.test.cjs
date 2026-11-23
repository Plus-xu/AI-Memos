const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSettings } = require('./helpers/environments.cjs');

const saved = {
  apiUrl: 'https://memos.example/',
  apiTokens: 'saved-pat',
  userName: 'users/tester',
  memosVersion: '26.11.2',
  hidetag: '私密',
  showtag: '公开'
};
const online = { 'auth/me': { user: { name: 'users/alice' } }, 'instance/profile': { version: '26.11.3' } };

/** Answers API requests by route; a route whose answer has a status is refused with it. */
const server = routes => options => {
  const answer = routes[new URL(options.url).pathname.replace('/api/', '')];
  if (!answer || answer.status) throw answer || { status: 404 };
  return answer;
};

async function submit(settings, url, token) {
  settings.element('apiUrl').value = url;
  if (token !== undefined) settings.element('apiTokens').value = token;
  let prevented = 0;
  await settings.element('connectionForm').onsubmit({ preventDefault: () => prevented++ });
  assert.equal(prevented, 1, 'the form must not be submitted by the browser');
}

test('saved settings fill the form, with a hint in place of the token', async () => {
  const settings = await loadSettings({ ...saved });
  assert.equal(settings.element('apiUrl').value, 'https://memos.example/');
  assert.equal(settings.element('apiTokens').value, '');
  assert.equal(settings.element('apiTokens').placeholder, 'modelSavedKey');
  assert.equal(settings.element('connectionStatus').textContent, 'users/tester · Memos 26.11.2');
  assert.equal(settings.element('hideInput').value, '私密');
  assert.equal(settings.element('showInput').value, '公开');
  assert.equal(settings.calls.length, 0);
});

test('a first run shows an empty form and no saved-token hint', async () => {
  const settings = await loadSettings();
  assert.equal(settings.element('apiUrl').value, '');
  assert.equal(settings.element('apiTokens').placeholder, undefined);
  assert.equal(settings.element('connectionStatus').textContent, '');
});

test('a verified connection is saved with a tidied address and token, and the token field is cleared', async () => {
  const progress = [];
  const settings = await loadSettings({}, options => {
    progress.push([settings.element('saveKey').disabled, settings.element('connectionStatus').textContent]);
    return server(online)(options);
  });
  await submit(settings, '  https://new.example//  ', ' new-pat ');
  assert.deepEqual(settings.storage, {
    apiUrl: 'https://new.example/',
    apiTokens: 'new-pat',
    userName: 'users/alice',
    userid: 'alice',
    memosVersion: '26.11.3'
  });
  assert.deepEqual(
    settings.calls.map(call => [call.url, call.headers.Authorization]),
    [
      ['https://new.example/api/auth/me', 'Bearer new-pat'],
      ['https://new.example/api/instance/profile', 'Bearer new-pat']
    ]
  );
  assert.deepEqual(progress[0], [true, 'working']);
  assert.equal(settings.element('saveKey').disabled, false);
  assert.equal(settings.element('apiTokens').value, '');
  assert.equal(settings.element('apiTokens').placeholder, 'modelSavedKey');
  assert.equal(settings.element('connectionStatus').textContent, 'settingsSaved · users/alice · Memos 26.11.3');
});

test('an empty token field means the saved token, as long as the address is the same', async () => {
  const settings = await loadSettings({ ...saved }, server(online));
  await submit(settings, 'https://memos.example');
  assert.equal(settings.calls[0].headers.Authorization, 'Bearer saved-pat');
  assert.equal(settings.storage.apiTokens, 'saved-pat');
  assert.equal(settings.storage.userName, 'users/alice');
});

test('the saved token is never sent to a different address; the token field is focused instead', async () => {
  const settings = await loadSettings({ ...saved }, server(online));
  let focused = 0;
  settings.element('apiTokens').focus = () => focused++;
  await submit(settings, 'https://other.example/');
  assert.equal(settings.calls.length, 0);
  assert.equal(settings.element('connectionStatus').textContent, 'placeApiTokens');
  assert.equal(focused, 1);
  assert.equal(settings.element('saveKey').disabled, undefined);
  assert.deepEqual(settings.storage, saved);
});

test('after a new connection is saved, an empty token field means the new token', async () => {
  const settings = await loadSettings({ ...saved }, server(online));
  await submit(settings, 'https://new.example/', 'new-pat');
  await submit(settings, 'https://new.example/');
  assert.equal(settings.calls.at(-1).headers.Authorization, 'Bearer new-pat');
  await submit(settings, 'https://memos.example/');
  assert.equal(settings.element('connectionStatus').textContent, 'placeApiTokens');
});

for (const [name, routes, url, status, requests] of [
  ['a rejected token', { 'auth/me': { status: 401 } }, 'https://new.example/', 'invalidToken', 1],
  ['an address that is not http(s)', online, 'javascript:alert(1)', 'invalidUrl', 0],
  ['a server error', { 'auth/me': { status: 500 } }, 'https://new.example/', 'apiFailed', 1]
]) {
  test(name + ' is reported, nothing is saved, and the form is ready for another try', async () => {
    const settings = await loadSettings({ ...saved }, server(routes));
    await submit(settings, url, 'typed-pat');
    assert.equal(settings.element('connectionStatus').textContent, status);
    assert.equal(settings.calls.length, requests);
    assert.deepEqual(settings.storage, saved);
    assert.equal(settings.element('saveKey').disabled, false);
    assert.equal(settings.element('apiTokens').value, 'typed-pat');
  });
}

test('a connection is still saved when the server version cannot be read', async () => {
  const settings = await loadSettings({}, server({ ...online, 'instance/profile': { status: 500 } }));
  await submit(settings, 'https://memos.example/', 'typed-pat');
  assert.equal(settings.storage.apiTokens, 'typed-pat');
  assert.equal(settings.storage.memosVersion, '');
  assert.equal(settings.element('connectionStatus').textContent, 'settingsSaved · users/alice');
});

test('tag rules are saved as plain tag names and written back to their fields', async () => {
  const settings = await loadSettings();
  settings.element('hideInput').value = '#私密，日记';
  settings.element('showInput').value = ' #公开  #公开 ';
  await settings.element('saveTag').onclick();
  assert.deepEqual(settings.storage, { hidetag: '私密 日记', showtag: '公开' });
  assert.equal(settings.element('hideInput').value, '私密 日记');
  assert.equal(settings.element('showInput').value, '公开');
  assert.deepEqual(settings.messages, ['settingsSaved']);
});

test('tag rules that cannot be stored are reported as not saved', async () => {
  const settings = await loadSettings();
  settings.context.chrome.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
  await settings.element('saveTag').onclick();
  assert.deepEqual(settings.messages, ['settingsSaveFailed']);
});
