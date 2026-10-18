import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { QQMusicService } from '../lib/index.js';

const LINES = [
  { t: 0, text: '第一行' },
  { t: 5000, text: '第二行' },
  { t: 10000, text: '第三行' },
];

function makeService(overrides = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-qqmusic-'));
  const watcher = {
    child: null,
    helperMissing: false,
    lastError: '',
    start() {},
    stop() {},
    getState: () => ({
      available: true,
      session: {
        source: 'QQMusic.exe',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        status: 'Playing',
        playing: true,
        positionMs: 6000,
        durationMs: 269000,
        lastUpdatedMs: Date.now(),
      },
    }),
    ...overrides.watcher,
  };
  const netease = {
    path: '',
    lastError: '',
    start() {},
    stop() {},
    getState: () => ({ available: false, session: null, reason: 'no-session' }),
    ...overrides.netease,
  };
  const resolver = async () => ({
    ok: true,
    source: 'qq',
    matched: { songmid: 'x', songid: 1, title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000, score: 1 },
    lrc: '',
    lines: LINES,
    instrumental: false,
  });
  const service = new QQMusicService(
    {},
    {
      home,
      watcher,
      netease,
      resolver: overrides.resolver ?? resolver,
      detailLookup: overrides.detailLookup,
      config: { enabled: true, offsetMs: 0, hints: true, ...(overrides.config ?? {}) },
    },
  );
  return { service, home, watcher, netease };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('状态机：按进度选行，切歌重新取词', async () => {
  const { service, home } = makeService();
  service._tick();
  await settle();
  const s1 = service.state();
  assert.equal(s1.available, true);
  assert.equal(s1.track.title, '晴天');
  assert.equal(s1.line.text, '第二行');

  // 进度前移 → 第三行
  const base = service.smtc.getState();
  service.smtc.getState = () => ({ ...base, session: { ...base.session, positionMs: 12000 } });
  service._tick();
  assert.equal(service.state().line.text, '第三行');

  // 切歌 → 重新取词（fake resolver 立即返回同一组行）
  service.smtc.getState = () => ({
    ...base,
    session: { ...base.session, title: '夜曲', positionMs: 100, durationMs: 227000 },
  });
  service._tick();
  await settle();
  assert.equal(service.state().track.title, '夜曲');

  rmSync(home, { recursive: true, force: true });
});

test('offsetMs 正数让歌词更早进入下一行', async () => {
  const { service, home } = makeService({ config: { offsetMs: 3000 } });
  service.smtc.getState = () => {
    const base = makeState(3500);
    return base;
  };
  function makeState(pos) {
    return {
      available: true,
      session: {
        source: 'QQMusic.exe',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        status: 'Playing',
        playing: true,
        positionMs: pos,
        durationMs: 269000,
        lastUpdatedMs: Date.now(),
      },
    };
  }
  service._tick();
  await settle();
  // 3500 + 3000 = 6500 → 第二行
  assert.equal(service.state().line.text, '第二行');
  rmSync(home, { recursive: true, force: true });
});

test('没有 SMTC 会话时给出结构化原因与提示', async () => {
  const { service, home } = makeService({
    watcher: {
      getState: () => ({ available: false, session: null, reason: 'no-session' }),
    },
  });
  service.qqmusicRunning = true;
  service._tick();
  const s = service.state();
  assert.equal(s.available, false);
  assert.equal(s.hint.code, 'smtc-off');
  assert.match(s.hint.text, /SMTC/);
  rmSync(home, { recursive: true, force: true });
});

test('关掉 enabled 后 state 仍可读，但浏览器侧不会投喂', async () => {
  const { service, home } = makeService({ config: { enabled: false } });
  service._tick();
  await settle();
  assert.equal(service.state().enabled, false);
  rmSync(home, { recursive: true, force: true });
});

test('state 的进度补到请求时刻，而不是停在上一次 tick', async () => {
  const { service, home } = makeService({
    watcher: {
      getState: () => ({
        available: true,
        session: {
          source: 'QQMusic.exe',
          title: '晴天',
          artist: '周杰伦',
          album: '叶惠美',
          status: 'Playing',
          playing: true,
          positionMs: 1000,
          durationMs: 269000,
          lastUpdatedMs: Date.now(),
        },
      }),
    },
  });
  service._tick();
  await settle();
  await new Promise((r) => setTimeout(r, 80));
  const s = service.state();
  assert.ok(s.positionMs >= 1050, '请求时应外推 80ms，实际 ' + s.positionMs);
  assert.equal(s.line.text, '第一行');
  rmSync(home, { recursive: true, force: true });
});

test('重新取词绕过缓存，且不会在下一 tick 重复请求', async () => {
  let calls = 0;
  const neteaseSession = {
    available: true,
    session: {
      source: 'cloudmusic.exe',
      player: 'netease',
      title: '起风了',
      artist: '买辣椒也用券',
      album: '起风了',
      status: 'Playing',
      playing: true,
      positionMs: 1000,
      durationMs: 325868,
      lastUpdatedMs: Date.now(),
      songId: '1330348068',
      positionSource: 'elog',
    },
  };
  const { service, home } = makeService({
    watcher: { getState: () => ({ available: false, session: null, reason: 'no-session' }) },
    netease: { getState: () => neteaseSession },
    resolver: async () => {
      calls++;
      return {
        ok: true,
        source: 'netease',
        matched: { songId: '1330348068', title: '起风了', artist: '买辣椒也用券', album: '起风了', durationMs: 325868, score: 1 },
        lrc: '',
        lines: LINES,
        instrumental: false,
      };
    },
  });
  service._tick();
  await settle();
  assert.equal(calls, 1);

  assert.equal(service.refreshLyrics(), true);
  await settle();
  assert.equal(calls, 2, '刷新必须重新取词，不能直接读缓存');

  service._tick();
  await settle();
  assert.equal(calls, 2, '下一 tick 不应把刷新当成切歌再取一次');
  rmSync(home, { recursive: true, force: true });
});

test('网易云只给 songId 时用取词结果补标题，不重复请求详情', async () => {
  let detailCalls = 0;
  const { service, home } = makeService({
    watcher: { getState: () => ({ available: false, session: null, reason: 'no-session' }) },
    netease: {
      getState: () => ({
        available: true,
        session: {
          source: 'cloudmusic.exe',
          player: 'netease',
          title: '',
          artist: '',
          album: '',
          status: 'Playing',
          playing: true,
          positionMs: 1000,
          durationMs: 0,
          lastUpdatedMs: Date.now(),
          songId: '999',
          positionSource: 'elog',
        },
      }),
    },
    resolver: async () => ({
      ok: true,
      source: 'netease',
      matched: { songId: '999', title: '详情歌名', artist: '详情歌手', album: '详情专辑', durationMs: 200000, score: 0 },
      lrc: '',
      lines: LINES,
      instrumental: false,
    }),
    detailLookup: async () => {
      detailCalls++;
      return null;
    },
  });
  service._tick();
  await settle();
  const s = service.state();
  assert.equal(s.track.title, '详情歌名');
  assert.equal(s.track.artist, '详情歌手');
  assert.equal(detailCalls, 0, '取词结果已经带详情，不应再查一次');
  rmSync(home, { recursive: true, force: true });
});
test('网易云 elog 会话：player / positionSource / songId 与按 id 取词', async () => {
  let resolverArgs = null;
  const { service, home } = makeService({
    watcher: { getState: () => ({ available: false, session: null, reason: 'no-session' }) },
    netease: {
      getState: () => ({
        available: true,
        session: {
          source: 'cloudmusic.exe',
          player: 'netease',
          title: '起风了',
          artist: '买辣椒也用券',
          album: '起风了',
          status: 'Playing',
          playing: true,
          positionMs: 30000,
          durationMs: 325868,
          lastUpdatedMs: Date.now(),
          songId: '1330348068',
          positionSource: 'elog',
        },
      }),
    },
    resolver: async (track, opts) => {
      resolverArgs = { track, opts };
      return {
        ok: true,
        source: 'netease',
        matched: { songId: '1330348068', title: '起风了', artist: '买辣椒也用券', album: '起风了', durationMs: 325868, score: 1 },
        lrc: '',
        lines: LINES,
        instrumental: false,
      };
    },
  });
  service._tick();
  await settle();
  const s = service.state();
  assert.equal(s.player, 'netease');
  assert.equal(s.positionSource, 'elog');
  assert.equal(s.songId, '1330348068');
  assert.equal(s.track.title, '起风了');
  assert.equal(resolverArgs.opts.player, 'netease');
  assert.equal(resolverArgs.opts.songId, '1330348068');
  assert.equal(s.line.text, '第三行');
  rmSync(home, { recursive: true, force: true });
});

test('SMTC 返回网易云会话时按 player 保留，不因 QQ 未启动而丢弃', async () => {
  const { service, home } = makeService({
    watcher: {
      getState: () => ({
        available: true,
        session: {
          source: 'cloudmusic.exe',
          player: 'netease',
          title: '岁月神偷',
          artist: '金玟岐',
          album: '',
          status: 'Paused',
          playing: false,
          positionMs: 0,
          durationMs: 0,
          lastUpdatedMs: -11644473600000,
        },
      }),
    },
    netease: { getState: () => ({ available: false, session: null, reason: 'no-session' }) },
  });
  service.qqmusicRunning = false;
  service.cloudmusicRunning = true;
  service._tick();
  const s = service.state();
  assert.equal(s.player, 'netease');
  assert.equal(s.available, true);
  assert.equal(s.positionSource, 'smtc');
  rmSync(home, { recursive: true, force: true });
});

test('player=qq 时不会被网易云 SMTC 会话顶替', async () => {
  const { service, home } = makeService({
    config: { player: 'qq' },
    watcher: {
      getState: () => ({
        available: true,
        session: {
          source: 'cloudmusic.exe',
          player: 'netease',
          title: '熄灭',
          artist: 'TC',
          playing: true,
          positionMs: 1000,
          durationMs: 148611,
          lastUpdatedMs: Date.now(),
        },
      }),
    },
    netease: { getState: () => ({ available: false, session: null, reason: 'no-session' }) },
  });
  service.qqmusicRunning = false;
  service.cloudmusicRunning = true;
  service._tick();
  assert.equal(service.state().available, false);
  rmSync(home, { recursive: true, force: true });
});

test('player=netease 时 elog 不可用可回退到网易云 SMTC', async () => {
  const { service, home } = makeService({
    config: { player: 'netease' },
    watcher: {
      getState: () => ({
        available: true,
        session: {
          source: 'cloudmusic.exe',
          player: 'netease',
          title: '岁月神偷',
          artist: '金玟岐',
          playing: true,
          positionMs: 30000,
          durationMs: 200000,
          lastUpdatedMs: Date.now(),
        },
      }),
    },
    netease: { getState: () => ({ available: false, session: null, reason: 'no-session' }) },
  });
  service.qqmusicRunning = false;
  service.cloudmusicRunning = true;
  service._tick();
  const s = service.state();
  assert.equal(s.player, 'netease');
  assert.equal(s.positionSource, 'smtc');
  assert.equal(s.available, true);
  rmSync(home, { recursive: true, force: true });
});

test('neteaseOffsetMs 只覆盖网易云，QQ 仍用 offsetMs', async () => {
  const neSession = {
    available: true,
    session: {
      source: 'cloudmusic.exe',
      player: 'netease',
      title: '起风了',
      artist: '买辣椒也用券',
      album: '起风了',
      status: 'Playing',
      playing: true,
      positionMs: 4000,
      durationMs: 325868,
      lastUpdatedMs: Date.now(),
      songId: '1330348068',
      positionSource: 'elog',
    },
  };
  const { service, home } = makeService({
    config: { offsetMs: 0, neteaseOffsetMs: 5000 },
    watcher: { getState: () => ({ available: false, session: null, reason: 'no-session' }) },
    netease: { getState: () => neSession },
  });
  service._tick();
  await settle();
  const s = service.state();
  assert.equal(s.player, 'netease');
  assert.equal(s.offsetMs, 5000);
  assert.equal(s.line.text, '第二行');
  rmSync(home, { recursive: true, force: true });
});

test('watcher 抛异常时 fail closed，不投喂脏状态', () => {
  const { service, home } = makeService({
    watcher: {
      getState: () => {
        throw new Error('smtc exploded');
      },
    },
  });
  service._tick();
  const s = service.state();
  assert.equal(s.available, false);
  assert.equal(s.playing, false);
  assert.equal(s.line, null);
  rmSync(home, { recursive: true, force: true });
});

test('网易云 elog 与 SMTC 同时可用时优先 elog', async () => {
  const { service, home } = makeService({
    watcher: {
      getState: () => ({
        available: true,
        session: {
          source: 'cloudmusic.exe',
          player: 'netease',
          title: '熄灭',
          artist: 'TC',
          playing: true,
          positionMs: 0,
          durationMs: 0,
          lastUpdatedMs: -11644473600000,
        },
      }),
    },
    netease: {
      getState: () => ({
        available: true,
        session: {
          source: 'cloudmusic.exe',
          player: 'netease',
          title: '熄灭',
          artist: 'TC',
          album: '熄灭',
          status: 'Playing',
          playing: true,
          positionMs: 50000,
          durationMs: 148611,
          lastUpdatedMs: Date.now(),
          songId: '2040015902',
          positionSource: 'elog',
        },
      }),
    },
  });
  service.qqmusicRunning = false;
  service.cloudmusicRunning = true;
  service._tick();
  const s = service.state();
  assert.equal(s.positionSource, 'elog');
  assert.ok(s.positionMs >= 50000 && s.positionMs < 51000, 'elog 原值应保留，实际 ' + s.positionMs);
  rmSync(home, { recursive: true, force: true });
});
