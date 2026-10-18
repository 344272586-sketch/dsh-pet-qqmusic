import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  NetEaseElogWatcher,
  decodeElog,
  encodeElog,
  makeTrack,
  parseElogHeader,
  parseElogLine,
} from '../lib/netease-elog.js';

const pad = (n) => String(n).padStart(2, '0');

function header(ts, date = new Date(), pid = 1) {
  const dt = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `[${pid}:2:1018/120000:${ts}:INFO:app.cpp(1)] [${dt}] `;
}

const TRACK = {
  id: '123456',
  name: '测试歌曲',
  duration: 200000,
  artists: [{ name: '测试歌手' }],
  album: { name: '测试专辑' },
};

function line(body, ts = Math.round(os.uptime() * 1000), date = new Date(), pid = 1) {
  return header(ts, date, pid) + body;
}

const silent = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test('parseElogHeader：uptime 与墙钟对不上时退回日志时间', () => {
  const ts = Math.round(os.uptime() * 1000) - 3600 * 1000;
  const h = parseElogHeader(line('x', ts));
  assert.ok(Number.isFinite(h.eventTimeMs));
  assert.ok(Math.abs(h.eventTimeMs - h.datetimeMs) < 1000, '应退回秒级墙钟');
  assert.equal(h.pid, 1);
});

test('parseElogLine：识别 crash server 的进程退出行', () => {
  const ev = parseElogLine(line('Process 16948 exited.', Math.round(os.uptime() * 1000), new Date(), 3540));
  assert.equal(ev.type, 'exit');
  assert.equal(ev.reason, 'process');
  assert.equal(ev.exitedPid, 16948);
  assert.equal(ev.pid, 3540);

  // 真实日志里这行没有第二段墙钟时间
  const bare = `[3540:20144:1018/110046:${Math.round(os.uptime() * 1000)}:INFO:cloudmusic_crash_server.cpp(470)] Process 16948 exited.`;
  const ev2 = parseElogLine(bare);
  assert.equal(ev2.type, 'exit');
  assert.equal(ev2.exitedPid, 16948);
  assert.equal(ev2.pid, 3540);
});

test('NetEaseElogWatcher：跨读取边界的汉字不会被劈坏', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-netease-'));
  const file = path.join(dir, 'cloudmusic.elog');
  writeFileSync(file, '');
  const w = new NetEaseElogWatcher({ path: file, pollMs: 80, logger: silent });
  w.start();
  await sleep(150);

  const buf = encodeElog(line(`【playing】,"checkPlayPrivilege",${JSON.stringify(TRACK)}`) + '\n');
  const cut = buf.indexOf(encodeElog('测')) + 1; // 正好切在「测」的三个字节中间
  assert.ok(cut > 0);
  appendFileSync(file, buf.subarray(0, cut));
  await sleep(200);
  assert.equal(w.getState().available, false, '半行还不能解析');

  appendFileSync(file, buf.subarray(cut));
  await sleep(200);
  const s = w.getState();
  assert.equal(s.available, true);
  assert.equal(s.session.title, '测试歌曲');
  assert.equal(s.session.artist, '测试歌手');

  w.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('NetEaseElogWatcher：渲染进程退出不清空，主进程退出才清空', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-netease-'));
  const file = path.join(dir, 'cloudmusic.elog');
  const ts = Math.round(os.uptime() * 1000);
  writeFileSync(
    file,
    encodeElog(
      [
        line(`【playing】,"playOneTrackInPlayingList",${JSON.stringify(TRACK)}`, ts, new Date(), 100),
        line('【playing】,"native播放state",1,"123456_X"', ts + 10, new Date(), 100),
      ].join('\n') + '\n',
    ),
  );
  const w = new NetEaseElogWatcher({ path: file, pollMs: 80, logger: silent });
  w.start();
  await sleep(200);
  assert.equal(w.getState().available, true);

  // crash server 报告渲染进程退出：不是主进程，忽略
  appendFileSync(
    file,
    encodeElog(line('Process 200 exited.', Math.round(os.uptime() * 1000), new Date(), 3540) + '\n'),
  );
  await sleep(200);
  assert.equal(w.getState().available, true, '渲染进程退出不应清空播放状态');

  // 主进程 100 退出：清空
  appendFileSync(
    file,
    encodeElog(line('Process 100 exited.', Math.round(os.uptime() * 1000), new Date(), 3540) + '\n'),
  );
  await sleep(200);
  assert.equal(w.getState().available, false, '主进程退出后应清空残留会话');

  w.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('NetEaseElogWatcher：预载时主进程已退出则直接用空状态', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-netease-'));
  const file = path.join(dir, 'cloudmusic.elog');
  const ts = Math.round(os.uptime() * 1000);
  writeFileSync(
    file,
    encodeElog(
      [
        line(`【playing】,"playOneTrackInPlayingList",${JSON.stringify(TRACK)}`, ts, new Date(), 100),
        line('【playing】,"native播放state",1,"123456_X"', ts + 10, new Date(), 100),
        line('Process 100 exited.', ts + 20, new Date(), 3540),
      ].join('\n') + '\n',
    ),
  );
  const w = new NetEaseElogWatcher({ path: file, pollMs: 80, logger: silent });
  w.start();
  await sleep(200);
  assert.equal(w.getState().available, false);
  w.stop();
  rmSync(dir, { recursive: true, force: true });
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
