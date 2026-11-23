const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { source } = require('./helpers/scripts.cjs');

const context = vm.createContext({});
vm.runInContext(source('memo-tags') + '\nglobalThis.tags = MemoTags;', context);
const tags = context.tags;
const extract = content => Array.from(tags.extract(content));
const strict = content => Array.from(tags.extract(content, true));

test('URL fragments and numeric tags do not hide a later tag', () => {
  assert.deepEqual(extract('见 https://a.com/p#top 然后 #私密'), ['私密']);
  assert.deepEqual(extract('第 #1 条 #私密'), ['1', '私密']);
  assert.deepEqual(extract('<https://e.com/#x> www.e.com/#y'), []);
});

test('code blocks and inline code are not scanned; indented code only counts in the cautious reading', () => {
  assert.deepEqual(extract('```c\n#include <stdio.h>\n```\n\n`#inline`'), []);
  assert.deepEqual(strict('```c\n#include <stdio.h>\n```\n\n`#inline`\n\n    #indented'), []);
  assert.deepEqual(extract('    #indented'), ['indented']);
  assert.deepEqual(extract('~~~\n#a\n~~~\n#plain'), ['plain']);
});

test('link text and destinations are skipped; text outside them is scanned', () => {
  assert.deepEqual(extract('[发布 #notes](https://e.com/r#frag) ![#alt](i#f) 外面 #memo-tag'), ['memo-tag']);
});

test('headings are not tags; hierarchical tags yield every ancestor', () => {
  assert.deepEqual(extract('## 标题\n\n# Title\n\n#work/测试 #C++ #R&D.'), ['work', 'work/测试', 'C++', 'R&D']);
  assert.deepEqual(extract("#book/ #first#second #tag's #users'"), ['book', 'first', 'second', "tag's", 'users']);
  assert.deepEqual(extract('#test🚀'), ['test🚀']);
});

test('rule tags match with or without a leading hash', () => {
  assert.equal(tags.normalize('  #私密 '), '私密');
  assert.equal(tags.normalize('私密'), '私密');
  assert.equal(tags.visibility('#公开', { hidetag: '私密', showtag: '#公开', memo_lock: 'PRIVATE' }), 'PUBLIC');
  assert.equal(tags.visibility('#私密', { hidetag: '#私密', showtag: '', memo_lock: 'PUBLIC' }), 'PRIVATE');
});

test('the hidden tag wins wherever it appears; no match keeps the selected visibility', () => {
  assert.equal(
    tags.visibility('#公开 文本 #私密', { hidetag: '#私密', showtag: '公开', memo_lock: 'PROTECTED' }),
    'PRIVATE'
  );
  assert.equal(tags.visibility('无标签', { hidetag: '私密', showtag: '公开', memo_lock: 'PROTECTED' }), 'PROTECTED');
  assert.equal(tags.visibility('#任意', { hidetag: '', showtag: '#', memo_lock: '' }), 'PRIVATE');
  assert.equal(tags.visibility('#work/secret', { hidetag: 'work', showtag: '', memo_lock: 'PUBLIC' }), 'PRIVATE');
  assert.equal(tags.visibility('`#私密`', { hidetag: '私密', showtag: '', memo_lock: 'PUBLIC' }), 'PUBLIC');
});

const rule = { hidetag: 'secret', showtag: 'open', memo_lock: 'PROTECTED' };

test('ambiguous text counts for the hidden tag but never for the public tag', () => {
  for (const content of [
    '- item\n    #secret',
    'para\n    #secret',
    '- a\n    - b #secret',
    'text\n\t#secret',
    '见https://a.com，然后#secret',
    '链接https://a.com）#secret',
    '    #secret'
  ]) {
    assert.equal(tags.visibility(content, rule), 'PRIVATE', content);
  }
  for (const content of ['    #open', '见https://a.com，然后#open', 'https://a.com/路径#open']) {
    assert.equal(tags.visibility(content, rule), 'PROTECTED', content);
  }
  assert.equal(tags.visibility('文本 #open', rule), 'PUBLIC');
});

test('stray backticks and one-line backtick fences do not swallow later paragraphs', () => {
  assert.deepEqual(extract('cost is 5` per unit\n\n#secret\n\nuse the ` key'), ['secret']);
  assert.deepEqual(extract('```js```\n#secret'), ['secret']);
  assert.deepEqual(extract('`a\n#code`\n\n#secret'), ['secret']);
});

test('long unbroken drafts are scanned quickly', () => {
  const inputs = [
    'QUJD'.repeat(5000),
    '#' + 'a'.repeat(50000),
    '#' + 'a/'.repeat(5000),
    '[\n'.repeat(2000),
    '['.repeat(20000)
  ];
  const started = performance.now();
  for (const input of inputs) {
    tags.extract(input);
    tags.extract(input, true);
  }
  assert.ok(performance.now() - started < 400, 'took ' + (performance.now() - started) + 'ms');
  assert.equal(extract('#' + 'a/'.repeat(40) + 'b').length, 1);
});

test('a rule accepts several tags separated by spaces or commas', () => {
  assert.deepEqual(Array.from(tags.list(' #日记, 工作，健康、#a/b  c ')), ['日记', '工作', '健康', 'a/b', 'c']);
  assert.deepEqual(Array.from(tags.list('日记 日记 #')), ['日记']);
  assert.equal(tags.normalize(' #日记, 工作，#健康 '), '日记 工作 健康');
  const many = { hidetag: '日记, 工作', showtag: '分享 博客', memo_lock: 'PROTECTED' };
  assert.equal(tags.visibility('今天 #工作', many), 'PRIVATE');
  assert.equal(tags.visibility('写了 #博客', many), 'PUBLIC');
  assert.equal(tags.visibility('#博客 #日记', many), 'PRIVATE');
  assert.equal(tags.visibility('#其他', many), 'PROTECTED');
});
