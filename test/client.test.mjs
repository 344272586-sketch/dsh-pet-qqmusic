import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

function makeState(lineIndex, text, extra = {}) {
  return {
    ok: true,
    at: Date.now(),
    enabled: true,
    available: true,
    playing: true,
    track: { title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000 },
    positionMs: lineIndex * 5000,
    durationMs: 269000,
    line: { index: lineIndex, text, t: lineIndex * 5000, endMs: (lineIndex + 1) * 5000 },
    nextLine: null,
    lyrics: { status: 'ready', source: 'qq', count: 3, instrumental: false, matched: null, error: '' },
    qqmusicRunning: true,
    hint: null,
    config: {
      enabled: true,
      petId: '',
      offsetMs: 0,
      keepAliveSec: 0,
      showTrackInfo: true,
      showTranslation: false,
      prefix: '♪ ',
      hints: true,
      debug: false,
    },
    ...extra,
  };
}

test('client：行变化才投喂，keepAlive 到点补发，提示节流', async () => {
  let state = makeState(0, '第一行');
  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/dsh-pet-qqmusic/state.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }
    if (u.pathname === '/dsh-pet-7340/broadcast') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const raw = JSON.parse(body || '{}').text || '';
        calls.push({ url: req.url, body: { text: raw.replace(/\u200B/g, '') }, raw });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => realFetch(new URL(url, base), opts);

  let dispose = null;
  const loaded = new Promise((resolve) => {
    globalThis.window = {
      __ModuleLoader__: {
        load(info) {
          const mod = info.factory(() => {
            throw new Error('no requires');
          });
          const ctx = {
            effect(fn) {
              dispose = fn();
              return dispose;
            },
          };
          mod.apply(ctx);
          resolve(mod);
        },
      },
    };
  });

  await import('../lib/client.js');
  await loaded;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, '♪ 第一行');
  assert.equal(calls[0].raw.charCodeAt(0), 0x200b, 'broadcast 必须带 U+200B 安静歌词标记');

  // 同一行不重复
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(calls.length, 1);

  // 切到第二行
  state = makeState(1, '第二行');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.text, '♪ 第二行');

  // keepAliveSec=1：同一行 1 秒后补发
  state = makeState(1, '第二行', { config: { ...state.config, keepAliveSec: 1 } });
  await new Promise((r) => setTimeout(r, 1600));
  assert.ok(calls.length >= 3);
  assert.equal(calls[calls.length - 1].body.text, '♪ 第二行');

  // 没有 SMTC 的提示 10 分钟只发一次
  state = makeState(0, '第一行', {
    available: false,
    playing: false,
    line: null,
    lyrics: { status: 'idle', count: 0 },
    hint: { code: 'smtc-off', text: 'QQ音乐没开 SMTC' },
  });
  await new Promise((r) => setTimeout(r, 700));
  const hintCalls = calls.filter((c) => c.body.text.includes('SMTC')).length;
  assert.equal(hintCalls, 1);

  if (dispose) dispose();
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});
