// Loopback-only fixture for the unpacked extension browser checks.
const http = require('node:http');
const { once } = require('node:events');

async function startFixture() {
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64'
  );
  const article =
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>社区阅读室的开放记录</title></head><body><nav>Fixture navigation</nav><article><h1>社区阅读室的开放记录</h1><section id="selection"><h2>读者反馈</h2><ul><li>延长周末开放时间</li><li>增加儿童图书</li></ul><table><thead><tr><th>时段</th><th>人数</th></tr></thead><tbody><tr><td>上午</td><td>23</td></tr></tbody></table><img src="/image.png" alt="阅读室照片"><a href="/notes">来源说明</a></section><p>' +
    '社区阅读室从今年春季起试行周末延时开放，工作人员记录了读者到访时段和借阅需求。'.repeat(8) +
    '</p><pre><code>open_at = 9</code></pre></article><footer>Fixture footer</footer></body></html>';
  const memos = new Map(),
    attachments = new Map(),
    calls = [];
  const state = {
    spaces: [{ name: 'spaces/reading', title: '阅读小组' }],
    loseReceipt: false,
    failUpload: false,
    aiDelay: 0
  };
  const examples = ['memos/first', 'memos/second'].map((name, i) => ({
    name,
    creator: 'users/reader',
    content: '阅读室 · ' + (i ? '周末到访' : '读者反馈'),
    tags: ['阅读'],
    visibility: i ? 'SPACE' : 'PRIVATE',
    createTime: '2026-11-16T10:00:00Z'
  }));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = url.pathname,
        method = req.method;
      if (/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || '')) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
      const reply = (code, value, type = 'application/json') => {
        if (!res.destroyed) {
          res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
          res.end(type === 'application/json' ? JSON.stringify(value) : value);
        }
      };
      if (route === '/article') return reply(200, article, 'text/html; charset=utf-8');
      if (route === '/image.png') return reply(200, image, 'image/png');
      if (route === '/short')
        return reply(
          200,
          '<title>短页</title><meta name="description" content="目录与索引"><p>目录</p>',
          'text/html; charset=utf-8'
        );
      if (!route.startsWith('/api/') && !route.startsWith('/v1/') && !route.startsWith('/file/')) return reply(404, {});
      if (req.headers.authorization !== (route.startsWith('/v1/') ? 'Bearer fixture-ai' : 'Bearer fixture-pat'))
        return reply(401, {});
      calls.push({ route, method, query: Object.fromEntries(url.searchParams), body });
      if (route === '/api/auth/me') return reply(200, { user: { name: 'users/reader' } });
      if (route === '/api/instance/profile') return reply(200, { version: '26.11.1' });
      if (route === '/api/spaces') return reply(200, { spaces: state.spaces });
      if (route === '/v1/models') return reply(200, { data: [{ id: 'fixture-text' }, { id: 'fixture-embedding-4' }] });
      if (route === '/v1/chat/completions') {
        if (body.model !== 'fixture-text') return reply(403, {});
        const phrase = '阅读室的周末开放时间是读者最关心的问题。';
        return setTimeout(
          () => reply(200, { choices: [{ finish_reason: 'stop', message: { content: phrase } }] }),
          state.aiDelay
        );
      }
      if (route === '/api/attachments' && method === 'POST') {
        if (state.failUpload) {
          state.failUpload = false;
          return reply(413, { message: 'Fixture size limit' });
        }
        const name = 'attachments/file-' + (attachments.size + 1);
        const file = { name, filename: body.filename, type: body.type, creator: 'users/reader' };
        attachments.set(name, file);
        return reply(200, file);
      }
      if (route.startsWith('/api/attachments/'))
        return reply(attachments.has(route.slice(5)) ? 200 : 404, attachments.get(route.slice(5)) || {});
      if (route.startsWith('/file/attachments/')) return reply(200, image, 'image/png');
      if (route === '/api/memos' && method === 'POST') {
        const id = url.searchParams.get('memoId') || String(memos.size + 1),
          name = 'memos/' + id;
        if (memos.has(name)) return reply(409, {});
        if (body.space && !state.spaces.some(s => s.name === body.space)) return reply(403, {});
        for (const file of body.attachments || []) {
          if (!attachments.has(file.name) || attachments.get(file.name).memo)
            return reply(400, { message: 'File already bound' });
          attachments.get(file.name).memo = name;
        }
        const memo = { ...body, name, creator: 'users/reader', createTime: new Date().toISOString() };
        memos.set(name, memo);
        if (state.loseReceipt) {
          state.loseReceipt = false;
          return reply(503, { message: 'Test response lost after commit' });
        }
        return reply(200, memo);
      }
      if (route === '/api/memos' && method === 'GET') {
        if (!url.searchParams.has('filter')) return reply(200, { memos: Array.from(memos.values()).concat(examples) });
        const more = url.searchParams.has('pageToken');
        return reply(200, {
          memos: more ? examples : examples.slice(0, 1),
          nextPageToken: more ? '' : 'page=2/opaque'
        });
      }
      if (route.startsWith('/api/memos/')) {
        const key = route.slice(5);
        return reply(memos.has(key) ? 200 : 404, memos.get(key) || {});
      }
      reply(404, {});
    } catch (error) {
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    memos,
    attachments,
    calls,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
module.exports = { startFixture };
