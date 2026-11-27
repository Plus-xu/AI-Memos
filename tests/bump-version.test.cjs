const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bumpVersion } = require('../scripts/bump-version.cjs');

function fixture(t, version = '2026.11.19.1') {
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'ai-memos-version-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), temp);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const npm = '2026.11.19-1';
  const original = {
    'manifest.json': '{\n  "version": "' + version + '",\n  "permissions": ["tabs", "storage"]\n}\n',
    'package.json': JSON.stringify({ private: true, version: npm }, null, 2) + '\n',
    'package-lock.json':
      JSON.stringify(
        { version: npm, packages: { '': { version: npm }, 'node_modules/example': { version: npm } } },
        null,
        2
      ) + '\n',
    'CHANGELOG.md': '# 修改记录\r\n\r\n## 未发布\r\n\r\n- New feature\r\n\r\n## ' + version + '\r\n\r\n- Previous\r\n'
  };
  for (const [file, content] of Object.entries(original)) fs.writeFileSync(path.join(root, file), content);
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const checkUnchanged = () => {
    for (const [file, content] of Object.entries(original)) assert.equal(read(file), content, file);
  };
  return { root, original, read, checkUnchanged };
}

test('one date version updates the extension, npm metadata and unreleased notes', t => {
  const { root, original, read } = fixture(t);
  assert.equal(bumpVersion(root, '2026.11.27.1'), '2026.11.19.1');
  assert.equal(read('manifest.json'), original['manifest.json'].replace('2026.11.19.1', '2026.11.27.1'));
  assert.equal(JSON.parse(read('package.json')).version, '2026.11.27-1');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, '2026.11.27-1');
  assert.equal(lock.packages[''].version, '2026.11.27-1');
  assert.equal(lock.packages['node_modules/example'].version, '2026.11.19-1');
  assert.equal(
    read('CHANGELOG.md'),
    original['CHANGELOG.md'].replace('## 未发布\r\n', '## 未发布\r\n\r\n## 2026.11.27.1\r\n')
  );
});

test('dating and sequence checks reject invalid releases before modifying files', t => {
  const { root, checkUnchanged } = fixture(t);
  for (const version of [
    '2026.11.18.1',
    '2026.11.19.1',
    '2026.11.19.3',
    '2026.11.20.2',
    '2026.11.31.1',
    '2026.12.01.1'
  ]) {
    assert.throws(() => bumpVersion(root, version));
  }
  checkUnchanged();
  assert.equal(bumpVersion(root, '2026.11.19.2'), '2026.11.19.1');
});

test('a file replacement failure restores versions already written and allows a retry', t => {
  const { root, checkUnchanged } = fixture(t, '2026.11.19');
  const rename = fs.renameSync;
  const replacement = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (path.basename(source) === 'CHANGELOG.md.after') throw new Error('Simulated locked changelog');
    return rename(source, destination);
  });

  assert.throws(() => bumpVersion(root, '2026.11.19.1'), /Simulated locked changelog/);
  checkUnchanged();
  replacement.mock.restore();
  assert.equal(bumpVersion(root, '2026.11.19.1'), '2026.11.19');
});
