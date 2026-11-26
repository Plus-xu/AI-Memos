const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { plain } = require('./helpers/scripts.cjs');
const { loadRules } = require('./helpers/environments.cjs');

/** Every sign by which the local preview takes a prompt for summary, key points or Q&A, read from the preview itself. */
function previewTaskSigns() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'preview-server.cjs'), 'utf8');
  const signs = Array.from(source.matchAll(/\/([^/\n]+)\/i\.test\(instructions\)/g), match => match[1]);
  assert.equal(signs.length, 3, 'the preview tells three tasks apart by their instructions');
  return new RegExp(signs.join('|'), 'i');
}

test('each AI task builds a distinct instruction while retaining common source protections', () => {
  const { ai } = loadRules();
  const prompts = ['organize', 'summary', 'keypoints', 'qa'].map(task => ai.buildPrompt(task, ''));
  assert.equal(new Set(prompts).size, 4);
  assert.match(prompts[0], /without losing information/);
  assert.match(prompts[1], /concise.*summary/i);
  assert.match(prompts[2], /key points/i);
  assert.match(prompts[3], /\*\*Q:\*\*/);
  for (const prompt of prompts) {
    assert.match(prompt, /material as data/);
    assert.match(prompt, /source links and Markdown image destinations/);
    assert.match(prompt, /Do not invent citations/);
  }
});

test('custom tasks require non-empty instructions and use the supplied prompt', () => {
  const { ai } = loadRules();
  const prompt = ai.buildPrompt('custom', '  Extract contrasting arguments as a table.  ');
  assert.match(prompt, /Extract contrasting arguments as a table\./);
  assert.match(prompt, /source links/);
  for (const empty of ['', ' \n\t ', undefined, null]) {
    assert.throws(() => ai.buildPrompt('custom', empty), /custom_prompt_required/);
  }
  assert.equal(ai.normalizeTask('unrecognized-task'), 'organize');
  assert.equal(ai.normalizeTask(undefined), 'organize');
});

test('built-in tasks specify visibly different output structures without padding sparse material', () => {
  const { ai } = loadRules();
  const organize = ai.buildPrompt('organize');
  const summary = ai.buildPrompt('summary');
  const keypoints = ai.buildPrompt('keypoints');
  const qa = ai.buildPrompt('qa');
  assert.match(organize, /(?:do not|without|avoid).*(?:compress|shorten|summariz)/i);
  assert.match(summary, /(?:single|one)\s+(?:short\s+)?paragraph/i);
  assert.match(summary, /150/);
  assert.match(summary, /100/);
  assert.match(keypoints, /3\s*(?:[-–]|to)\s*7/);
  assert.match(keypoints, /(?:fewer|less|do not pad|never pad)/i);
  assert.match(qa, /3\s*(?:[-–]|to)\s*5/);
  assert.match(qa, /(?:fewer|less|do not pad|never pad)/i);
  assert.match(qa, /\*\*Q:\*\*/);
  assert.match(qa, /\*\*A:\*\*/);
});

test('creating a review keeps original and result separate until an explicit apply', () => {
  const { ai } = loadRules();
  const input = 'Original note\n\n![image](/file/attachments/photo/a.png)';
  const result = 'Organized note\n\n![image](/file/attachments/photo/a.png)';
  const review = ai.review(input, result, 'summary');
  assert.equal(review.input, input);
  assert.equal(review.result, result);
  assert.equal(review.task, 'summary');
  assert.ok(Number.isFinite(Date.parse(review.createdAt)));
  assert.deepEqual(plain(ai.apply(review, input, 'replace')), { before: input, after: result });
  assert.equal(review.input, input, 'applying must not mutate the saved original');
  for (const invalid of ['', '   ', '\n\t', null, 42]) {
    assert.throws(() => ai.review(input, invalid, 'summary'), /invalid_ai_result/);
  }
});

test('replace rejects stale original text instead of silently overwriting edits', () => {
  const { ai } = loadRules();
  const review = ai.review('Original draft', 'AI answer', 'organize');
  for (const changed of ['Original draft plus a new line', '', 'Completely new draft']) {
    assert.throws(() => ai.apply(review, changed, 'replace'), /ai_edit_conflict/);
  }
  assert.throws(() => ai.apply(review, review.input, 'unknown-action'), /invalid_review_action/);
});

test('append uses the latest draft and undo returns its exact original spacing', () => {
  const { ai } = loadRules();
  const review = ai.review('Earlier input', 'AI answer', 'keypoints');
  const latest = 'Latest user edit\n\n';
  const transaction = ai.apply(review, latest, 'append');
  assert.deepEqual(plain(transaction), { before: latest, after: 'Latest user edit\n\nAI answer' });
  assert.equal(ai.undo(transaction, transaction.after), latest);
  assert.equal(ai.apply(review, '', 'append').after, 'AI answer');
  assert.throws(() => ai.undo(transaction, transaction.after + '\nAnother user edit'), /ai_undo_conflict/);
  assert.throws(() => ai.undo(null, transaction.after), /ai_undo_conflict/);
});

test('missing-reference warnings include source links and managed images without duplicates', () => {
  const { ai } = loadRules();
  const input =
    '[source](https://example.org/report?id=7)\nhttps://example.org/report?id=7\n![image](/file/attachments/photo/a.png)';
  const review = ai.review(input, '[source](https://example.org/report?id=7)', 'summary');
  assert.deepEqual(plain(ai.missingReferences(review)), ['/file/attachments/photo/a.png']);
  review.result += '\n![image](/file/attachments/photo/a.png)';
  assert.deepEqual(plain(ai.missingReferences(review)), []);
  assert.deepEqual(plain(ai.missingReferences(ai.review(input, 'Text without references', 'summary'))), [
    'https://example.org/report?id=7',
    '/file/attachments/photo/a.png'
  ]);
});

test('a changed URL sharing the original prefix is still reported as missing', () => {
  const { ai } = loadRules();
  const review = ai.review(
    '[source](https://example.org/article)\n![image](/file/attachments/photo/a.png)',
    '[different](https://example.org/article-other)\n![different](/file/attachments/photo/a.png-other)',
    'summary'
  );
  assert.deepEqual(plain(ai.missingReferences(review)), [
    'https://example.org/article',
    '/file/attachments/photo/a.png'
  ]);
});

test('bracketed hosts and balanced parentheses do not hide changes to a source URL', () => {
  const { ai } = loadRules();
  const cases = [
    ['https://en.wikipedia.org/wiki/Apple_(fruit)#Cultivation', 'https://en.wikipedia.org/wiki/Apple_(fruit)#History'],
    ['https://[2001:db8::1]/original', 'https://[2001:db8::1]/different']
  ];
  for (const [original, changed] of cases) {
    const review = ai.review('<' + original + '>', '<' + changed + '>', 'summary');
    assert.deepEqual(plain(ai.missingReferences(review)), [original]);
    assert.deepEqual(plain(ai.missingReferences(ai.review('<' + original + '>', '<' + original + '>', 'summary'))), []);
  }
});

const capture = {
  content: 'First selected paragraph.\n\nSecond selected paragraph.',
  title: 'A useful article',
  url: 'https://example.org/article?id=7&utm_source=test#part-two',
  capturedAt: '2026-11-12T01:02:03+08:00'
};

test('default clipping quotes every selected line and includes verifiable source and time', () => {
  const { clipper } = loadRules();
  const formatted = clipper.format(capture);
  assert.equal(
    formatted,
    [
      '> First selected paragraph.',
      '> ',
      '> Second selected paragraph.',
      '',
      '[A useful article](https://example.org/article?id=7&utm_source=test#part-two)',
      '',
      '2026-11-11T17:02:03.000Z'
    ].join('\n')
  );
});

test('capture formatting normalizes Windows line endings and safely escapes source titles and URL parentheses', () => {
  const { clipper } = loadRules();
  const source = {
    ...capture,
    content: '  First\r\nSecond\r\n  ',
    title: 'Title [part] \\ more\r\ncontinued',
    url: 'https://example.org/a(b)?id=2'
  };
  const before = plain(source);
  const formatted = clipper.format(source);
  assert.match(formatted, /^> First\n> Second\n/);
  assert.ok(formatted.includes('[Title \\[part\\] \\\\ more continued](https://example.org/a%28b%29?id=2)'));
  assert.deepEqual(source, before, 'formatting must not mutate the capture record');
});

test('capture URLs allow HTTP(S) only and reject credentials or browser-owned pages', () => {
  const { clipper } = loadRules();
  assert.equal(clipper.safeUrl('http://example.org/source?id=7'), 'http://example.org/source?id=7');
  for (const url of [
    'javascript:alert(1)',
    'data:text/plain,secret',
    'file:///C:/secret.txt',
    'chrome://extensions/',
    'blob:https://example.org/id',
    'https://user:password@example.org/source'
  ]) {
    assert.throws(() => clipper.format({ ...capture, url }), /invalid_capture_url/);
  }
  assert.throws(() => clipper.format({ ...capture, url: 'not an absolute URL' }));
});

test('templates require source and content, and enforce the configured size limit', () => {
  const { clipper } = loadRules();
  for (const template of [
    '',
    '{{content}}',
    '{{url}}',
    '{{title}} {{date}}',
    null,
    '{{content}} {{url}}' + 'x'.repeat(8000)
  ]) {
    assert.throws(() => clipper.validateTemplate(template), /invalid_clip_template/);
  }
  const template = '### {{ title }}\n\n{{ content }}\n\nSource: {{ url }}';
  assert.equal(clipper.validateTemplate(template), template);
  assert.equal(
    clipper.format(capture, template),
    ['### A useful article', '', capture.content, '', 'Source: ' + capture.url].join('\n')
  );
});

test('selection text that looks like a template stays literal and is not expanded a second time', () => {
  const { clipper } = loadRules();
  const source = { ...capture, content: 'Literal {{url}} and {{title}}\nLiteral {{date}} and {{content}}' };
  assert.equal(clipper.format(source, '{{content}}\nSource: {{url}}'), source.content + '\nSource: ' + source.url);
  const quoted = clipper.format(source);
  assert.ok(quoted.startsWith('> Literal {{url}} and {{title}}\n> Literal {{date}} and {{content}}'));
  const nestedQuote = clipper.format(source, '> > {{content}}\n\n{{url}}');
  assert.ok(nestedQuote.startsWith('> > Literal {{url}} and {{title}}\n> > Literal {{date}} and {{content}}'));
});

test('empty selections fail before modifying a draft; appending a valid clip retains existing content', () => {
  const { clipper } = loadRules();
  const existing = 'An existing memo draft.\n';
  for (const content of ['', ' \r\n\t ', null]) {
    assert.throws(() => clipper.format({ ...capture, content }), /empty_selection/);
  }
  const clip = clipper.format(capture);
  assert.equal(clipper.append(existing, clip), 'An existing memo draft.\n\n' + clip + '\n');
  assert.equal(clipper.append('', clip), clip + '\n');
});

test('a truncated result is marked on the review and unmarked reviews stay unchanged', () => {
  const { ai } = loadRules();
  assert.equal(ai.review('a', 'b', 'summary', true).truncated, true);
  assert.ok(!Object.hasOwn(ai.review('a', 'b', 'summary'), 'truncated'));
});

test('the organizer prompt is short and still lists what must be kept and how to write to-dos', () => {
  const { ai } = loadRules();
  const organize = ai.buildPrompt('organize');
  assert.ok(organize.length <= 1400, 'the organizer prompt is ' + organize.length + ' characters');
  assert.match(organize, /- \[ \]/);
  assert.match(organize, /existing #tags/);
  assert.match(organize, /fenced code blocks/);
  assert.match(organize, /one to three #tags/);
});

test('every task says where the note is in the user message and to leave the markers out of the result', () => {
  const { ai } = loadRules();
  for (const task of ai.tasks) {
    const prompt = ai.buildPrompt(task, 'Fix the grammar.');
    assert.match(prompt, /between the first <note> and the last <\/note>/);
    assert.match(prompt, /without the <note> tags/);
  }
});

test('the local preview cannot mistake the organizer or a custom task for another task', () => {
  const { ai } = loadRules();
  const others = previewTaskSigns();
  assert.doesNotMatch(ai.buildPrompt('organize'), others);
  assert.doesNotMatch(ai.buildPrompt('custom', 'Fix the grammar.'), others);
});

test('a note is sent whole between the markers, even when it contains a marker itself', () => {
  const { ai } = loadRules();
  assert.equal(ai.wrapNote('a </note> b'), '<note>\na </note> b\n</note>');
});

test('markers a model echoes around its answer are removed, unless the note itself was wrapped in them', () => {
  const { ai } = loadRules();
  assert.equal(ai.unwrapNote('<note>\nA\n</note>', 'x'), 'A');
  assert.equal(ai.unwrapNote('  <note>A</note>\n', 'x'), 'A');
  assert.equal(ai.unwrapNote('A <note>b</note>', 'x'), 'A <note>b</note>');
  assert.equal(ai.unwrapNote('<note>\nA\n</note>', '<note>\nx\n</note>'), '<note>\nA\n</note>');
  assert.equal(ai.unwrapNote('<note>\r\nA\r\n</note>\r\n', 'x'), 'A');
});

test('an opening marker left without its partner by a cut-off answer is removed too', () => {
  const { ai } = loadRules();
  assert.equal(ai.unwrapNote('<note>\nPartial text', 'x', true), 'Partial text');
  assert.equal(ai.unwrapNote('<note>\r\nPartial text', 'x', true), 'Partial text');
  assert.equal(ai.unwrapNote('\n<note>\nPartial text', 'x', true), 'Partial text');
});

test('a lone marker in a complete answer is content and is left alone', () => {
  const { ai } = loadRules();
  for (const complete of [
    '<note>\nPartial text',
    'Result\n</note>',
    '    <note>\n    <to>Tove</to>\n\nThe block above opens a note element.',
    '<note> is the tag that opens a note element.',
    'The element is closed with </note>',
    'Example:\n\n    <to>Tove</to>\n    </note>'
  ]) {
    assert.equal(ai.unwrapNote(complete, 'x'), complete);
    assert.equal(ai.unwrapNote(complete, 'x', false), complete);
  }
});

test('a cut-off answer keeps a lone marker that is indented, shares its line, closes, or that the note starts with', () => {
  const { ai } = loadRules();
  for (const cutOff of [
    '    <note>\n    <to>Tove</to>',
    '\n    <note>\n    <to>Tove</to>',
    '<note> is the tag that opens',
    'Result\n</note>',
    'Example:\n\n    </note>'
  ]) {
    assert.equal(ai.unwrapNote(cutOff, 'x', true), cutOff);
  }
  assert.equal(ai.unwrapNote('<note>\nPartial text', '<note> draft', true), '<note>\nPartial text');
  assert.equal(ai.unwrapNote('<note>a</note> tail', 'x', true), '<note>a</note> tail');
});

test('markers are only removed as a pair when the first one is closed by the last one', () => {
  const { ai } = loadRules();
  const blocks = '<note>A</note>\n\n<note>B</note>';
  assert.equal(ai.unwrapNote(blocks, 'intro\n' + blocks), blocks);
  assert.equal(ai.unwrapNote('<note>\nA <note>b</note> c\n</note>', 'x'), 'A <note>b</note> c');
  const unbalanced = '<note>\nA `<note>` b\n</note>';
  assert.equal(ai.unwrapNote(unbalanced, 'x'), unbalanced);
});

test('a pair of markers indented as Markdown code is content and is left alone', () => {
  const { ai } = loadRules();
  for (const code of [
    '    <note>\n    <to>Tove</to>\n    </note>',
    '\t<note>\n\t<to>Tove</to>\n\t</note>',
    '\n    <note>\n    <to>Tove</to>\n    </note>\n',
    '<note>\nText\n\n    <to>Tove</to>\n    </note>',
    '<note>\r\nText\r\n\r\n\t</note>\r\n'
  ]) {
    assert.equal(ai.unwrapNote(code, 'x'), code);
    assert.equal(ai.unwrapNote(code, 'x', true), code);
  }
  assert.equal(ai.unwrapNote('   <note>\nA\n   </note>', 'x'), 'A');
  assert.equal(ai.unwrapNote('<note>\n    code</note>', 'x'), '    code');
});

test('a marker at one end is left alone when the answer holds other markers', () => {
  const { ai } = loadRules();
  const opens = '<note>A</note>\n\nUse `<note>` to open.';
  assert.equal(ai.unwrapNote(opens, 'x', true), opens);
  const closes = 'Use `</note>` to close.\n<note>A</note>';
  assert.equal(ai.unwrapNote(closes, 'x', true), closes);
});

test('the interface language instruction keeps existing tags and gives no example tags', () => {
  const { ai } = loadRules();
  const organize = ai.buildPrompt('organize');
  assert.match(organize, /existing #tags/);
  assert.match(
    ai.languageInstruction('ui', 'organize', 'zh_CN'),
    /已有的 # 标签原样保留.*只有新增的标签才使用简体中文/
  );
  assert.match(ai.languageInstruction('ui', 'organize', 'en'), /Keep every existing #tag exactly as written/);
  assert.match(ai.languageInstruction('ui', 'organize', 'ja'), /既にある # タグはそのまま保持/);
  for (const language of ['zh_CN', 'en', 'ja']) {
    assert.doesNotMatch(ai.languageInstruction('ui', 'summary', language), /#[^\s#]+ #[^\s#]+/, language);
  }
});

test('the output language setting and the task together choose the language instruction', () => {
  const { ai } = loadRules();
  assert.deepEqual(plain(ai.outputLanguages), ['auto', 'ui', 'source']);
  const source = /^# Output language\n/;
  const ui = /^# 输出语言要求\n/;
  const weakSource = /^Unless the task above specifies an output language.*language the note is written in/;
  const weakUi = /^Unless the task above specifies an output language.*Simplified Chinese \(简体中文\)/;
  const table = {
    auto: { organize: source, summary: ui, keypoints: ui, qa: ui },
    ui: { organize: ui, summary: ui, keypoints: ui, qa: ui, custom: weakUi },
    source: { organize: source, summary: source, keypoints: source, qa: source, custom: weakSource }
  };
  for (const [mode, row] of Object.entries(table)) {
    for (const [task, expected] of Object.entries(row)) {
      assert.match(ai.languageInstruction(mode, task, 'zh_CN'), expected, mode + ' ' + task);
    }
  }
  assert.equal(ai.languageInstruction('auto', 'custom', 'zh_CN'), '');
  assert.match(ai.languageInstruction('source', 'organize', 'zh_CN'), /Do not translate it into another language/);
});

test('the interface language instruction follows the interface language and falls back to English', () => {
  const { ai } = loadRules();
  const english = ai.languageInstruction('ui', 'summary', 'en');
  assert.match(english, /^# Output Language Requirement\n/);
  assert.match(ai.languageInstruction('ui', 'summary', 'ja'), /^# 出力言語の要件\n/);
  for (const other of ['fr', '', undefined]) assert.equal(ai.languageInstruction('ui', 'summary', other), english);
  assert.match(ai.languageInstruction('ui', 'custom', 'ja'), /write the output in Japanese \(日本語\)\.$/);
  assert.match(ai.languageInstruction('ui', 'custom', 'fr'), /write the output in English\.$/);
});

test('unrecognized output language values and tasks fall back to automatic and organize', () => {
  const { ai } = loadRules();
  for (const invalid of [undefined, null, '', 'zh', 'AUTO', 1, {}]) {
    assert.equal(ai.normalizeOutputLanguage(invalid), 'auto');
  }
  for (const valid of ['auto', 'ui', 'source']) assert.equal(ai.normalizeOutputLanguage(valid), valid);
  assert.equal(ai.languageInstruction('bogus', 'summary', 'zh_CN'), ai.languageInstruction('auto', 'summary', 'zh_CN'));
  assert.equal(
    ai.languageInstruction('auto', 'unknown-task', 'zh_CN'),
    ai.languageInstruction('auto', 'organize', 'zh_CN')
  );
});

test('no language instruction makes the local preview mistake the organizer or a custom task', () => {
  const { ai } = loadRules();
  const others = previewTaskSigns();
  for (const mode of ai.outputLanguages) {
    for (const task of ['organize', 'custom']) {
      for (const language of ['zh_CN', 'en', 'ja']) {
        assert.doesNotMatch(ai.languageInstruction(mode, task, language), others);
      }
    }
  }
});

test('a review records why it is incomplete, and each reason has its own warning', () => {
  const { ai } = loadRules();
  const recorded = reason => ai.review('Draft', 'Result', 'organize', reason).truncated;
  assert.deepEqual(['stopped', 'interrupted', 'ended', true, 'max_tokens', false, undefined].map(recorded), [
    'stopped',
    'interrupted',
    'ended',
    true,
    true,
    undefined,
    undefined
  ]);
  assert.deepEqual(
    ['stopped', 'interrupted', 'ended', true, false, undefined].map(reason => ai.incompleteMessage(reason)),
    ['aiStoppedWarning', 'aiInterruptedWarning', 'aiEndedWarning', 'aiTruncatedWarning', '', '']
  );
});

test('an answer cut off in the middle of a marker loses the part of the marker it has', () => {
  const { ai } = loadRules();
  for (const begun of ['<', '<n', '<no', '<not', '<note', '\n<no', ' \n\n<note'])
    assert.equal(ai.unwrapNote(begun, 'x', true), '', JSON.stringify(begun) + ' is no text yet');
  assert.equal(ai.unwrapNote('<note>\r', 'x', true), '', 'half of the line end after the marker');
  assert.equal(ai.unwrapNote('\r<no', 'x', true), '');
  assert.equal(ai.unwrapNote('\r<note>\r', 'x', true), '');
  assert.equal(ai.unwrapNote('<note>\rText\r</no', 'x', true), 'Text');
  assert.equal(ai.unwrapNote('<note>\rText\r</note>', 'x'), 'Text');
  assert.equal(ai.unwrapNote('\r    <note>\rText\r    </note>', 'x'), '\r    <note>\rText\r    </note>');
  for (const ending of ['<', '</', '</n', '</no', '</not', '</note', '  </no'])
    assert.equal(ai.unwrapNote('<note>\nText\n' + ending, 'x', true), 'Text', JSON.stringify(ending));
  assert.equal(ai.unwrapNote('<note>\n</no', 'x', true), '');
  // Only a last line that is nothing else: text before it on the line makes it content.
  assert.equal(ai.unwrapNote('<note>\nText </no', 'x', true), 'Text </no');
  assert.equal(ai.unwrapNote('<note>\nif a <', 'x', true), 'if a <');
  // Nor a last line indented as code: that is what the note ends with, cut off where it was.
  for (const code of ['    <', '    </no', '\t<', '     </note'])
    assert.equal(
      ai.unwrapNote('<note>\nExample:\n\n    <to>Tove</to>\n' + code, 'x', true),
      'Example:\n\n    <to>Tove</to>\n' + code,
      JSON.stringify(code)
    );

  // What only looks like it stays: text on the marker's line, a comparison, a complete answer, a note in markers.
  for (const [result, input, truncated] of [
    ['a < b and <no', 'x', true],
    ['Text\n</no', 'x', true],
    ['<nothing', 'x', true],
    ['<no', 'x', false],
    ['<note>\nText\n</no', 'x', false],
    ['<no', '<note>\nquoted\n</note>', true],
    ['<note>\nText\n</no', '<note>\nquoted\n</note>', true]
  ])
    assert.equal(ai.unwrapNote(result, input, truncated), result, JSON.stringify(result));
});

test('blank lines before an echoed marker accept mixed line endings and preserve indentation', () => {
  const { ai } = loadRules();
  const blank = ' \t\r\n\r\n\t\r \n';
  assert.equal(ai.unwrapNote(blank + '<no', 'Draft', true), '');
  assert.equal(ai.unwrapNote(blank + '<note>\r\nFirst\rSecond', 'Draft', true), 'First\rSecond');
  for (const content of ['First paragraph', '  <no', '    <note>\r\nExample']) {
    assert.equal(ai.unwrapNote(blank + content, 'Draft', true), blank + content);
  }
});
