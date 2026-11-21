const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/memo-tags.js'), 'utf8') + '\nglobalThis.tags = MemoTags;', context);
const tags = context.tags;
const extract = content => Array.from(tags.extract(content));

test('URL fragments and numeric tags do not hide a later tag', () => {
  assert.deepEqual(extract('见 https://a.com/p#top 然后 #私密'), ['私密']);
  assert.deepEqual(extract('第 #1 条 #私密'), ['1', '私密']);
  assert.deepEqual(extract('<https://e.com/#x> www.e.com/#y'), []);
});

test('code blocks, inline code and indented code are not scanned for tags', () => {
  assert.deepEqual(extract('```c\n#include <stdio.h>\n```\n\n`#inline`\n\n    #indented'), []);
  assert.deepEqual(extract('~~~\n#a\n~~~\n#plain'), ['plain']);
});

test('link text and destinations are skipped; text outside them is scanned', () => {
  assert.deepEqual(extract('[发布 #notes](https://e.com/r#frag) ![#alt](i#f) 外面 #memo-tag'), ['memo-tag']);
});

test('headings are not tags; hierarchical tags yield every ancestor', () => {
  assert.deepEqual(extract('## 标题\n\n# Title\n\n#work/测试 #C++ #R&D.'), ['work', 'work/测试', 'C++', 'R&D']);
  assert.deepEqual(extract('#book/ #first#second #tag\'s #users\''), ['book', 'first', 'second', "tag's", 'users']);
  assert.deepEqual(extract('#test🚀'), ['test🚀']);
});

test('rule tags match with or without a leading hash', () => {
  assert.equal(tags.normalize('  #私密 '), '私密');
  assert.equal(tags.normalize('私密'), '私密');
  assert.equal(tags.visibility('#公开', { hidetag: '私密', showtag: '#公开', memo_lock: 'PRIVATE' }), 'PUBLIC');
  assert.equal(tags.visibility('#私密', { hidetag: '#私密', showtag: '', memo_lock: 'PUBLIC' }), 'PRIVATE');
});

test('the hidden tag wins wherever it appears; no match keeps the selected visibility', () => {
  assert.equal(tags.visibility('#公开 文本 #私密', { hidetag: '#私密', showtag: '公开', memo_lock: 'PROTECTED' }), 'PRIVATE');
  assert.equal(tags.visibility('无标签', { hidetag: '私密', showtag: '公开', memo_lock: 'PROTECTED' }), 'PROTECTED');
  assert.equal(tags.visibility('#任意', { hidetag: '', showtag: '#', memo_lock: '' }), 'PRIVATE');
  assert.equal(tags.visibility('#work/secret', { hidetag: 'work', showtag: '', memo_lock: 'PUBLIC' }), 'PRIVATE');
  assert.equal(tags.visibility('`#私密`', { hidetag: '私密', showtag: '', memo_lock: 'PUBLIC' }), 'PUBLIC');
});
