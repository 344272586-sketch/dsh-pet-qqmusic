import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

test('client：按 nextLine.t 主动排程下一行，且宿主未切行时不回跳', async () => {
  const start = Date.now();
  const state = {
    ok: true,
    at: start,
    enabled: true,
    available: true,
    playing: true,
    track: { title: '测试曲', artist: '测试歌手', album: '', durationMs: 10000 },
    positionMs: 0,
    durationMs: 10000,
    line: { index: 0, text: 'A', t: 0, endMs: 1000 },
    nextLine: { index: 1, text: 'B', t: 1000, endMs: 2000 },
    lyrics: { status: 'ready', source: 'qq', count: 2, instrumental: false, matched: null, error: '' },
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
  };

  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/dsh-pet-qqmusic/state.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...state, at: Date.now(), positionMs: Date.now() - start }));
      return;
    }
    if (u.pathname === '/dsh-pet-7340/broadcast') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const raw = JSON.parse(body || '{}').text || '';
        calls.push(raw.replace(/\u200B/g, ''));
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
          mod.apply({
            effect(fn) {
              dispose = fn();
              return dispose;
            },
          });
          resolve(mod);
        },
      },
    };
  });

  await import('../lib/client.js?schedule=1');
  await loaded;

  await new Promise((r) => setTimeout(r, 250));
  assert.ok(calls.includes('♪ A'), 'first line should be sent');

  // 主动排程在 1000-120=880ms 左右把 B 发出去
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(calls.includes('♪ B'), 'next line should be scheduled before the poll sees it');

  // 宿主 state 仍是 A；pending 期间不能回跳到 A
  const countB = calls.filter((x) => x === '♪ B').length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.filter((x) => x === '♪ A').length, 1, 'must not revert to A');
  assert.ok(calls.filter((x) => x === '♪ B').length >= countB);

  if (dispose) dispose();
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});
