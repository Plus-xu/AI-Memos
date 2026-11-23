const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { root, pageScripts } = require('./helpers/scripts.cjs');
const { loadPage, loadWorker } = require('./helpers/environments.cjs');

const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pages = ['popup.html', 'options.html', 'panel.html'];
const languages = ['en', 'ja', 'zh_CN'];
const locales = Object.fromEntries(
  languages.map(language => [language, JSON.parse(read('_locales/' + language + '/messages.json'))])
);
const keys = Object.keys(locales.en);

/** The extension's own scripts: everything in js/ except the two bundled libraries and js/vendor. */
const ownScripts = fs
  .readdirSync(path.join(root, 'js'))
  .filter(name => name.endsWith('.js') && !['jquery.min.js', 'view-image.js'].includes(name))
  .map(name => 'js/' + name);
const runtimeText = [...ownScripts, ...pages].map(read).join('\n');

test('the three languages define the same keys, each with a message', () => {
  for (const language of languages) {
    assert.deepEqual(Object.keys(locales[language]).sort(), keys.toSorted(), language);
    const empty = keys.filter(
      key => typeof locales[language][key].message !== 'string' || !locales[language][key].message
    );
    assert.deepEqual(empty, [], language + ' has entries without a message');
  }
});

test('every {name} and {{name}} placeholder of a message is in all three languages', () => {
  const placeholders = (language, key) => (locales[language][key].message.match(/\{\{?\w+\}?\}/g) || []).sort();
  const differing = keys.filter(key =>
    languages.some(language => placeholders(language, key).join() !== placeholders('en', key).join())
  );
  assert.deepEqual(differing, []);
});

test('every message key is used: as a word in a script or page, in the manifest, or as an AI task name', () => {
  const manifest = read('manifest.json');
  const unused = keys.filter(
    key =>
      !new RegExp('(?<![\\w$])' + key + '(?![\\w$])').test(runtimeText) &&
      !manifest.includes('__MSG_' + key + '__') &&
      !/^aiTask(Help)?_/.test(key)
  );
  assert.deepEqual(unused, []);
});

test('every message key written out in a page attribute, a message call or the manifest exists (keys chosen by a condition or built at run time are not seen)', () => {
  const used = new Set();
  const collect = (text, pattern) => {
    for (const hit of text.matchAll(pattern)) used.add(hit[1]);
  };
  for (const page of pages) collect(read(page), /\bdata-(?:feature-message|placeholder|title|label)="([^"]*)"/g);
  for (const script of ownScripts)
    collect(read(script), /\b(?:uiMessage|getLLMMessage|chrome\.i18n\.getMessage)\(\s*'([^']*)'\s*[,)]/g);
  collect(read('manifest.json'), /__MSG_(\w+)__/g);
  assert.ok(used.size > 100, 'the patterns no longer find the keys');
  assert.deepEqual(
    Array.from(used).filter(key => !keys.includes(key)),
    []
  );
});

test('the manifest, package.json and the lock file carry the same version', () => {
  const version = JSON.parse(read('package.json')).version;
  const lock = JSON.parse(read('package-lock.json'));
  assert.match(version, /^\d+\.\d+\.\d+-\d+$/);
  assert.equal(JSON.parse(read('manifest.json')).version, version.replace('-', '.'));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});

test('every script and stylesheet a page names exists, and none is named twice', () => {
  for (const page of pages) {
    const styles = Array.from(read(page).matchAll(/<link\b[^>]*\bhref="([^"]+)"/g), hit => hit[1]);
    const files = [...pageScripts(page), ...styles];
    assert.ok(files.length, page + ' names no files');
    assert.deepEqual(
      files.filter(file => !fs.existsSync(path.join(root, file))),
      [],
      page + ' names missing files'
    );
    assert.deepEqual(
      files.filter((file, index) => files.indexOf(file) !== index),
      [],
      page + ' names a file twice'
    );
  }
});

/**
 * Names a script declares in its header but that are absent where it is loaded. Each use is behind a
 * typeof check, or in a function that page never calls; anything else missing is a forgotten <script>.
 */
const absent = {
  'options.html': [
    'js/ai-optimize.js memoSaveInProgress', // typeof-guarded; only the popup saves memos
    'js/ai-review.js memoSaveInProgress', // typeof-guarded
    'js/clipper.js DraftEditor', // typeof-guarded
    'js/clipper.js Workspace', // typeof-guarded
    'js/clipper.js memoSaveInProgress', // typeof-guarded
    'js/i18n.js Workspace' // typeof-guarded
  ],
  'background.js': ['js/staged-files.js MemosAPI'] // only resolve() uploads; the worker calls fromUrl() alone
};

function missingGlobals({ context, scripts }) {
  const missing = [];
  for (const script of scripts) {
    const header = read(script).match(/^\/\* global ([^*]*)\*\//m);
    const names = header ? header[1].split(',').map(name => name.trim()) : [];
    for (const name of names.filter(Boolean)) {
      if (vm.runInContext('typeof ' + name, context) === 'undefined') missing.push(script + ' ' + name);
    }
  }
  return missing.sort();
}

for (const page of pages) {
  test(page + ' loads its scripts in a working order, and they find the globals they declare', () => {
    const loaded = loadPage(page);
    assert.deepEqual(
      loaded.scripts,
      pageScripts(page).filter(script => ownScripts.includes(script))
    );
    assert.deepEqual(missingGlobals(loaded), absent[page] || []);
  });
}

test('the service worker loads, and its scripts find the globals they declare', () => {
  const loaded = loadWorker();
  assert.ok(loaded.scripts.length > 1, 'importScripts loaded nothing');
  assert.deepEqual(missingGlobals(loaded), absent['background.js']);
});

test('every npm script the CI workflow runs is defined in package.json', () => {
  const run = Array.from(read('.github/workflows/ci.yml').matchAll(/\bnpm run ([\w:-]+)/g), hit => hit[1]);
  assert.ok(run.length, 'the workflow runs no npm scripts');
  const defined = Object.keys(JSON.parse(read('package.json')).scripts);
  assert.deepEqual(
    run.filter(name => !defined.includes(name)),
    []
  );
});
