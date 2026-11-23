/** Loading the extension's plain scripts into a vm context, the way a page loads them. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Source of js/<name>.js; the extension is optional. */
function source(name) {
  return fs.readFileSync(path.join(root, 'js', name.endsWith('.js') ? name : name + '.js'), 'utf8');
}

function loadScripts(context, names) {
  for (const name of names) vm.runInContext(source(name), context, { filename: name });
  return context;
}

/** Script paths of an extension page, in the order the browser would run them. */
function pageScripts(page) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  return Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g), match => match[1]);
}

/** A real Response carrying JSON, as a server would answer. */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

module.exports = { root, plain, flush, source, loadScripts, pageScripts, jsonResponse };
