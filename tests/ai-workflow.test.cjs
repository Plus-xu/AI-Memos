const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));

function loadRules() {
  const context = vm.createContext({ URL });
  for (const file of ['ai-workflow.js', 'clipper-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), context, { filename: file });
  }
  return { ai: context.AIWorkflow, clipper: context.ClipperCore };
}

test('each AI task builds a distinct instruction while retaining common source protections', () => {
  const { ai } = loadRules();
  const prompts = ['organize', 'summary', 'keypoints', 'qa'].map(task => ai.buildPrompt(task, '', 'LEGACY_ORGANIZER_RULES'));
  assert.equal(new Set(prompts).size, 4);
  assert.match(prompts[0], /without losing information/);
  assert.match(prompts[0], /LEGACY_ORGANIZER_RULES/);
  assert.match(prompts[1], /concise.*summary/i);
  assert.match(prompts[2], /key points/i);
  assert.match(prompts[3], /\*\*Q:\*\*/);
  for (const prompt of prompts) {
    assert.match(prompt, /material as data/);
    assert.match(prompt, /source links and Markdown image destinations/);
    assert.match(prompt, /Do not invent citations/);
  }
  for (const prompt of prompts.slice(1)) {
    assert.ok(!prompt.includes('LEGACY_ORGANIZER_RULES'), 'summarizing and question generation must not inherit the organizer-only task');
  }
});

test('custom tasks require non-empty instructions and use the supplied prompt', () => {
  const { ai } = loadRules();
  const prompt = ai.buildPrompt('custom', '  Extract contrasting arguments as a table.  ', 'UNRELATED_LEGACY_RULE');
  assert.match(prompt, /Extract contrasting arguments as a table\./);
  assert.ok(!prompt.includes('UNRELATED_LEGACY_RULE'));
  assert.match(prompt, /source links/);
  for (const empty of ['', ' \n\t ', undefined, null]) {
    assert.throws(() => ai.buildPrompt('custom', empty), /custom_prompt_required/);
  }
  assert.equal(ai.normalizeTask('unrecognized-task'), 'organize');
  assert.equal(ai.normalizeTask(undefined), 'organize');
});

test('built-in tasks specify visibly different output structures without padding sparse material', () => {
  const { ai } = loadRules();
  const organize = ai.buildPrompt('organize', '', 'LEGACY_ORGANIZER_RULES');
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
  const input = '[source](https://example.org/report?id=7)\nhttps://example.org/report?id=7\n![image](/file/attachments/photo/a.png)';
  const review = ai.review(input, '[source](https://example.org/report?id=7)', 'summary');
  assert.deepEqual(plain(ai.missingReferences(review)), ['/file/attachments/photo/a.png']);
  review.result += '\n![image](/file/attachments/photo/a.png)';
  assert.deepEqual(plain(ai.missingReferences(review)), []);
  assert.deepEqual(plain(ai.missingReferences(ai.review(input, 'Text without references', 'summary'))), [
    'https://example.org/report?id=7', '/file/attachments/photo/a.png'
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
    'https://example.org/article', '/file/attachments/photo/a.png'
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
  assert.equal(formatted, [
    '> First selected paragraph.',
    '> ',
    '> Second selected paragraph.',
    '',
    '[A useful article](https://example.org/article?id=7&utm_source=test#part-two)',
    '',
    '2026-11-11T17:02:03.000Z'
  ].join('\n'));
});

test('capture formatting normalizes Windows line endings and safely escapes source titles and URL parentheses', () => {
  const { clipper } = loadRules();
  const source = { ...capture, content: '  First\r\nSecond\r\n  ', title: 'Title [part] \\ more\r\ncontinued', url: 'https://example.org/a(b)?id=2' };
  const before = plain(source);
  const formatted = clipper.format(source);
  assert.match(formatted, /^> First\n> Second\n/);
  assert.ok(formatted.includes('[Title \\[part\\] \\\\ more continued](https://example.org/a%28b%29?id=2)'));
  assert.deepEqual(source, before, 'formatting must not mutate the capture record');
});

test('capture URLs allow HTTP(S) only and reject credentials or browser-owned pages', () => {
  const { clipper } = loadRules();
  assert.equal(clipper.safeUrl('http://example.org/source?id=7'), 'http://example.org/source?id=7');
  for (const url of ['javascript:alert(1)', 'data:text/plain,secret', 'file:///C:/secret.txt', 'chrome://extensions/', 'blob:https://example.org/id', 'https://user:password@example.org/source']) {
    assert.throws(() => clipper.format({ ...capture, url }), /invalid_capture_url/);
  }
  assert.throws(() => clipper.format({ ...capture, url: 'not an absolute URL' }));
});

test('templates require source and content, and enforce the configured size limit', () => {
  const { clipper } = loadRules();
  for (const template of ['', '{{content}}', '{{url}}', '{{title}} {{date}}', null, '{{content}} {{url}}' + 'x'.repeat(8000)]) {
    assert.throws(() => clipper.validateTemplate(template), /invalid_clip_template/);
  }
  const template = '### {{ title }}\n\n{{ content }}\n\nSource: {{ url }}';
  assert.equal(clipper.validateTemplate(template), template);
  assert.equal(clipper.format(capture, template), [
    '### A useful article', '', capture.content, '', 'Source: ' + capture.url
  ].join('\n'));
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
