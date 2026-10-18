import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseTitle,
  cacheKey,
  isInstrumental,
  mergeTranslation,
  parseLrc,
  pickBest,
  resolveLyrics,
  scoreCandidate,
  stripLeadingCredits,
} from '../lib/lyrics.js';

test('parseLrc：基础时间戳与文本', () => {
  const { lines, hasTime } = parseLrc('[ti:晴天]\n[00:02.25]词：周杰伦\n[00:12.34]故事的小黄花\n[01:02.5]从出生那年就飘着');
  assert.equal(hasTime, true);
  assert.deepEqual(
    lines.map((l) => [l.t, l.text]),
    [
      [2250, '词：周杰伦'],
      [12340, '故事的小黄花'],
      [62500, '从出生那年就飘着'],
    ],
  );
});

test('parseLrc：一行多时间戳会展开', () => {
  const { lines } = parseLrc('[00:01.00][00:05.50]副歌');
  assert.deepEqual(lines.map((l) => l.t), [1000, 5500]);
  assert.deepEqual(lines.map((l) => l.text), ['副歌', '副歌']);
});

test('parseLrc：offset 正值让歌词提前', () => {
  const { lines } = parseLrc('[offset:500]\n[00:10.00]hello');
  assert.equal(lines[0].t, 9500);
});

test('parseLrc：跳过无时间戳标签与空行', () => {
  const { lines } = parseLrc('[ar:周杰伦]\n[al:叶惠美]\n\n[00:01.00]   ');
  assert.equal(lines.length, 0);
});

test('mergeTranslation：按时间戳配对，不按顺序硬贴', () => {
  const lines = parseLrc('[00:01.00]hello\n[00:05.00]world').lines;
  const merged = mergeTranslation(lines, '[00:01.05]你好\n[00:09.00]错位翻译');
  assert.equal(merged[0].trans, '你好');
  assert.equal(merged[1].trans, undefined);
});

test('isInstrumental：占位文案 ≤3 行才判定', () => {
  assert.equal(isInstrumental(parseLrc('[00:01.00]此歌曲为没有填词的纯音乐，请您欣赏').lines), true);
  assert.equal(isInstrumental(parseLrc('[00:01.00]纯音乐，请欣赏\n[00:02.00]纯音乐，请欣赏').lines), true);
  assert.equal(isInstrumental(parseLrc('[00:01.00]纯音乐，请欣赏\n[00:02.00]真的歌词\n[00:03.00]第三行\n[00:04.00]第四行').lines), false);
});

test('baseTitle：去掉版本括号与 feat', () => {
  assert.equal(baseTitle('晴天 (Live)'), baseTitle('晴天'));
  assert.equal(baseTitle('Say Something (feat. Someone)'), baseTitle('Say Something'));
});

test('scoreCandidate：同名同歌手同时长最高，Live 版本降权', () => {
  const track = { title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000 };
  const studio = { title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000 };
  const live = { title: '晴天 (Live)', artist: '周杰伦', album: '演唱会', durationMs: 280000 };
  const other = { title: '晴天娃娃', artist: '江语晨', album: '', durationMs: 200000 };
  assert.ok(scoreCandidate(track, studio) > scoreCandidate(track, live));
  assert.equal(scoreCandidate(track, other), 0);
  assert.equal(pickBest(track, [live, studio]).cand.title, '晴天');
});

test('cacheKey：同曲稳定，不同时长不同键', () => {
  const a = { title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000 };
  assert.equal(cacheKey(a), cacheKey({ ...a }));
  assert.notEqual(cacheKey(a), cacheKey({ ...a, durationMs: 280000 }));
});

test('cacheKey：网易云按 songId 命中，标题/时长补齐后仍是同一个键', () => {
  const bare = { player: 'netease', songId: '3343962691', title: '', artist: '', album: '', durationMs: 0 };
  const full = { player: 'netease', songId: '3343962691', title: '无始无终', artist: 'TC', album: '无始无终', durationMs: 158429 };
  assert.equal(cacheKey(bare), cacheKey(full));
  assert.notEqual(cacheKey(bare), cacheKey({ ...full, songId: '3343962692' }));
  // QQ 仍按标题/时长区分版本
  assert.notEqual(
    cacheKey({ player: 'qq', title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269000 }),
    cacheKey({ player: 'qq', title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 280000 }),
  );
});

test('stripLeadingCredits：去掉开头词曲编曲与标题行，正文里的“词：”不误删', () => {
  const track = { title: '晴天', artist: '周杰伦' };
  const lines = parseLrc(
    '[00:00.00]晴天 - 周杰伦 (Jay Chou)\n[00:02.00]词：周杰伦\n[00:04.00]曲：周杰伦\n[00:29.00]故事的小黄花\n[00:32.00]词：这是正文里的词',
  ).lines;
  const out = stripLeadingCredits(lines, track);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, '故事的小黄花');
  assert.equal(out[1].text, '词：这是正文里的词');
});

test('stripLeadingCredits：整首都是名单时原样返回', () => {
  const track = { title: '晴天', artist: '周杰伦' };
  const lines = parseLrc('[00:01.00]词：周杰伦\n[00:02.00]曲：周杰伦').lines;
  assert.equal(stripLeadingCredits(lines, track).length, 2);
});

test('按 songId 取词时详情失败不阻断歌词接口', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/song/detail')) throw new Error('detail down');
    if (u.includes('/api/song/lyric')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 200,
            lrc: { lyric: '[00:01.000]hello' },
            tlyric: { lyric: '' },
          }),
      };
    }
    throw new Error('unexpected ' + u);
  };
  try {
    const r = await resolveLyrics(
      { songId: '1', title: '', artist: '', album: '', durationMs: 0 },
      { player: 'netease', songId: '1', timeoutMs: 1000 },
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, 'netease');
    assert.equal(r.lines[0].text, 'hello');
  } finally {
    globalThis.fetch = realFetch;
  }
});
