import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NetEaseElogWatcher, decodeElog, encodeElog, makeTrack, parseElogLine } from '../lib/netease-elog.js';

const pad = (n) => String(n).padStart(2, '0');

function header(ts, date = new Date()) {
  const dt = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `[1:2:1018/120000:${ts}:INFO:app.cpp(1)] [${dt}] `;
}

const TRACK = {
  id: '123456',
  name: '测试歌曲',
  duration: 200000,
  artists: [{ name: '测试歌手' }],
  album: { name: '测试专辑' },
};

function line(body, ts = Math.round(os.uptime() * 1000), date = new Date()) {
  return header(ts, date) + body;
}

test('decode/encode elog 可逆，中文不乱码', () => {
  const text = '{ "name": "测试歌曲", "artist": "测试歌手" }\n';
  const round = decodeElog(encodeElog(text));
  assert.equal(round, text);
});

test('parseElogLine：切歌 / seek / 播放状态', () => {
  const a = parseElogLine(line(`【playing】,"checkPlayPrivilege",${JSON.stringify(TRACK)}`));
  assert.equal(a.type, 'set-playing');
  assert.equal(makeTrack(a.data).title, '测试歌曲');
  assert.equal(makeTrack(a.data).songId, '123456');

  const b = parseElogLine(line('【playing】,"setPlayingPosition",12.5'));
  assert.equal(b.type, 'seek');
  assert.equal(b.positionSec, 12.5);

  const c = parseElogLine(line('【playing】,"native播放state",2,"123456_X"'));
  assert.equal(c.type, 'status');
  assert.equal(c.status, 2);

  const d = parseElogLine(line(`【playing】,"native播放资源load完成，开始播放",{"songId":"123456"}`));
  assert.equal(d.type, 'native-load');
  assert.equal(d.songId, '123456');
});

test('NetEaseElogWatcher：预载暂停位置，追加事件后前进/seek', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-netease-'));
  const file = path.join(dir, 'cloudmusic.elog');
  const ts = Math.round(os.uptime() * 1000);
  const logs = [
    line(`【playing】,"checkPlayPrivilege",${JSON.stringify(TRACK)}`, ts),
    line('【playing】,"native播放state",1,"123456_X"', ts + 10),
    line('【playing】,"setPlayingPosition",12.5', ts + 20),
    line('【playing】,"native播放state",2,"123456_X"', ts + 30),
  ];
  writeFileSync(file, encodeElog(logs.join('\n') + '\n'));

  const w = new NetEaseElogWatcher({ path: file, pollMs: 100, logger: { log() {}, warn() {}, error() {} } });
  w.start();
  await new Promise((r) => setTimeout(r, 350));
  let s = w.getState();
  assert.equal(s.available, true);
  assert.equal(s.session.title, '测试歌曲');
  assert.equal(s.session.artist, '测试歌手');
  assert.equal(s.session.playing, false);
  assert.ok(Math.abs(s.session.positionMs - 12500) < 1500, 'paused position ≈ 12.5s, got ' + s.session.positionMs);
  assert.equal(s.session.songId, '123456');

  appendFileSync(file, encodeElog(line('【playing】,"native播放state",1,"123456_X"', Math.round(os.uptime() * 1000)) + '\n'));
  await new Promise((r) => setTimeout(r, 350));
  s = w.getState();
  assert.equal(s.session.playing, true);
  assert.ok(s.session.positionMs >= 12500, 'playing should advance');

  appendFileSync(file, encodeElog(line('【playing】,"setPlayingPosition",30', Math.round(os.uptime() * 1000)) + '\n'));
  await new Promise((r) => setTimeout(r, 350));
  s = w.getState();
  assert.ok(s.session.positionMs >= 29500, 'seek to 30s, got ' + s.session.positionMs);

  w.stop();
  rmSync(dir, { recursive: true, force: true });
});
