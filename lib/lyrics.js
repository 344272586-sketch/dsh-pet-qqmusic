/**
 * QQ 音乐取词内核（纯函数 + 两个网络入口，宿主侧专用）。
 *
 * 设计口径：
 * - **只依赖 Web 标准 fetch**：DSH 桌面端 Node 22 自带 fetch，插件不引入任何 npm 依赖。
 * - **解析与打分是纯函数**：LRC 解析、纯音乐识别、候选版本匹配都能脱离网络单测。
 * - **失败显式返回结构化原因**：网络/解析失败不抛到路由层，调用方据此决定是否降级。
 * - **匹配优先看时长**：同名歌曲常有 Live / Remix / 伴奏版本，SMTC 给了时长，
 *   用「标题 + 歌手 + 时长」三者打分能显著减少「歌词对不上版本」。
 *
 * 数据来源（公开 Web 接口，与 QQ 音乐客户端同源）：
 *   搜索：https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp
 *   歌词：https://u.y.qq.com/cgi-bin/musicu.fcg (music.musichallSong.PlayLyricInfo)
 *
 * 注意：这些接口不是腾讯官方开放 API，可能随客户端改版失效；失效时 resolveLyrics
 * 会回落到 lrclib（若可访问），仍然失败则显式返回 error，绝不伪造歌词。
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const QQ_REFERER = 'https://y.qq.com/';
const NETEASE_REFERER = 'https://music.163.com/';
const NETEASE_COOKIE = 'appver=2.0.2';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 纯音乐占位文案（QQ 音乐/网易云都会返回这类句子，长度 ≤3 行时才判定） */
const INSTRUMENTAL_HINTS = [
  '此歌曲为没有填词的纯音乐',
  '此歌曲为纯音乐',
  '纯音乐，请欣赏',
  '纯音乐请欣赏',
  '该歌曲为纯音乐',
  '暂无歌词',
  '暂时没有歌词',
  '这首歌暂时没有歌词',
  '没有填词的纯音乐',
];

/** 版本标记：源曲名没有、候选有 → 降权 */
const VERSION_MARKERS = [
  'live',
  '演唱会',
  '现场',
  'remix',
  '混音',
  '伴奏',
  'instrumental',
  '纯音乐',
  'cover',
  '翻唱',
  'demo',
  '片段',
  '试听',
  'dj',
  '女声',
  '男声',
  '加速',
  '降调',
];

/** HTML 实体最小解码（QQ 搜索偶尔返回 &nbsp; / &amp;） */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/** 全角转半角 + 小写 + 去首尾空白 */
export function normalizeText(s) {
  return decodeEntities(s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .trim();
}

/** 去掉括号/连字符后的版本尾巴，用于「基础歌名」比较 */
export function baseTitle(title) {
  let s = normalizeText(title);
  s = s.replace(/\([^)]*\)/g, ' ').replace(/（[^）]*）/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  s = s.split(/\s+-\s+/)[0];
  s = s.replace(/\s+feat\.?.*$/, ' ');
  return s.replace(/[\s\-_/·,.，。!！?？'"“”‘’]+/g, '');
}

/** 歌手归一：拆分合唱、去空格与标点 */
export function normalizeArtist(artist) {
  const raw = Array.isArray(artist) ? artist.join('/') : String(artist ?? '');
  return raw
    .split(/[/、,&;]|\bfeat\.?\b|\bft\.?\b/i)
    .map((s) => normalizeText(s).replace(/[\s\-_/·,.，。!！?？'"“”‘’]+/g, ''))
    .filter(Boolean);
}

/** 是否带「源曲没有」的版本标记 */
function hasExtraVersionMarker(sourceTitle, candTitle) {
  const src = normalizeText(sourceTitle);
  const cand = normalizeText(candTitle);
  return VERSION_MARKERS.some((m) => cand.includes(m) && !src.includes(m));
}

/**
 * 解析 LRC。
 * 支持 [mm:ss.xx] / [mm:ss.xxx] / 一行多时间戳 / [offset:±ms]；
 * 无时间戳的行（歌词元信息、纯文本歌词）直接跳过。
 *
 * @param {string} text LRC 原文
 * @returns {{ lines: Array<{t:number,text:string}>, offset:number, hasTime:boolean }}
 */
export function parseLrc(text) {
  const lines = [];
  let offset = 0;
  if (typeof text !== 'string' || !text) return { lines, offset, hasTime: false };

  // 有些接口返回的是 \r\n，也有单独 \r
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const raw of rawLines) {
    const offsetMatch = raw.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetMatch) offset = Number(offsetMatch[1]) || 0;
  }

  for (const raw of rawLines) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (tags.length === 0) continue;
    // 文本 = 最后一个时间标签之后的内容
    const last = tags[tags.length - 1];
    const textPart = raw.slice((last.index ?? 0) + last[0].length).trim();
    if (!textPart) continue;
    // 过滤纯元信息（万一被写成带时间戳的标签行）
    if (/^\[[a-z]+:/i.test(textPart)) continue;

    for (const m of tags) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      const fracRaw = m[3] ?? '0';
      // .5 = 500ms，.50 = 500ms，.500 = 500ms
      const frac = Number(fracRaw.padEnd(3, '0').slice(0, 3)) || 0;
      const t = min * 60_000 + sec * 1000 + frac;
      lines.push({ t, text: textPart });
    }
  }

  // 标准语义：offset 为正表示歌词应提前显示
  if (offset) for (const line of lines) line.t -= offset;
  lines.sort((a, b) => a.t - b.t || a.text.localeCompare(b.text));

  // 同一时间戳的重复行去重（QQ 音乐偶尔会重复返回）
  const deduped = [];
  for (const line of lines) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.t === line.t && prev.text === line.text) continue;
    deduped.push(line);
  }
  return { lines: deduped, offset, hasTime: deduped.length > 0 };
}

/**
 * 把翻译 LRC 合并到原文行上。
 * 优先按时间戳配对（±120ms），找不到就放弃——不按顺序硬贴，避免整首错位。
 */
export function mergeTranslation(lines, transText) {
  const trans = parseLrc(transText).lines;
  if (!trans.length) return lines;
  const out = lines.map((line) => ({ ...line }));
  let j = 0;
  for (const line of out) {
    while (j < trans.length && trans[j].t < line.t - 120) j++;
    if (j < trans.length && Math.abs(trans[j].t - line.t) <= 120) {
      const t = trans[j].text.trim();
      if (t && t !== line.text) line.trans = t;
    }
  }
  return out;
}

/** 纯音乐判定：整首 ≤3 行且每行都命中占位语 */
export function isInstrumental(lines) {
  const texts = lines.map((l) => String(l.text ?? '').trim()).filter(Boolean);
  if (texts.length === 0) return false;
  if (texts.length > 3) return false;
  return texts.every((t) => INSTRUMENTAL_HINTS.some((hint) => t.includes(hint)));
}

/** 歌词开头的制作名单（QQ 音乐 LRC 常把词曲编曲放在最前面，桌宠没必要念） */
const CREDIT_RE =
  /^\s*(作词|作曲|词曲|编曲|词|曲|制作人|制作统筹|制作|监制|出品人|出品公司|出品|发行公司|发行|吉他|贝斯|鼓|键盘|弦乐编写|弦乐|大提琴|小提琴|中提琴|低音提琴|和声编写|和声|合声编写|合声|录音师|录音助理|录音工程|录音室|录音棚|录音|混音工程|混音室|混音(?:\s*\/\s*母带)?|母带|杜比全景声(?:混音)?|人声(?:录音)?|配唱制作人|配唱|企划统筹|统筹|企划|音乐制作|封面|设计|版权|未经许可|特别鸣谢|鸣谢|OP|SP|A&R|Program|Producer|Composer|Lyricist|Arranger|Guitar|Bass|Drums|Piano|Strings|Backing Vocal|Recorded|Mixed|Mastered)\s*[：:]/i;

/** 是否是「歌名 - 歌手」标题行（QQ 音乐 LRC 的第一行） */
function isTitleLine(text, track) {
  const t = normalizeText(text);
  if (!t) return false;
  const title = baseTitle(track.title);
  const artist = normalizeArtist(track.artist)[0] ?? '';
  if (!title || !t.includes(title)) return false;
  if (artist && !t.includes(artist)) return false;
  return t.includes('-') || t.includes('–') || t.includes('—') || t.startsWith(title);
}

/**
 * 去掉开头的制作名单 / 标题行，避免桌宠前 30 秒念「词：周杰伦」。
 * 只在**开头连续**的名单行上生效；正文里出现「词：」不会误删。
 * 如果整首都是名单（极少见），原样返回，交给后续流程判定。
 */
export function stripLeadingCredits(lines, track) {
  let i = 0;
  while (i < lines.length) {
    const text = String(lines[i].text ?? '');
    if (CREDIT_RE.test(text) || isTitleLine(text, track)) i++;
    else break;
  }
  if (i === 0 || i >= lines.length) return lines;
  return lines.slice(i);
}

/**
 * 给一个 QQ 音乐候选打分（0~1）。
 * @param {{title:string, artist:string, album?:string, durationMs?:number}} track SMTC 曲目
 * @param {{title:string, artist:string, album?:string, durationMs?:number}} cand 候选
 */
export function scoreCandidate(track, cand) {
  const titleSrc = baseTitle(track.title);
  const titleCand = baseTitle(cand.title);
  let score = 0;

  if (titleSrc && titleCand) {
    if (titleSrc === titleCand) score += 0.55;
    else if (titleSrc.includes(titleCand) || titleCand.includes(titleSrc)) score += 0.34;
    else return 0; // 歌名完全对不上，直接淘汰
  } else {
    return 0;
  }

  const srcArtists = normalizeArtist(track.artist);
  const candArtists = normalizeArtist(cand.artist);
  if (srcArtists.length && candArtists.length) {
    const hit = srcArtists.some((a) => candArtists.some((b) => a === b || a.includes(b) || b.includes(a)));
    if (hit) score += 0.24;
    else score -= 0.18;
  }

  if (track.album && cand.album) {
    if (normalizeText(track.album) === normalizeText(cand.album)) score += 0.08;
  }

  if (track.durationMs && cand.durationMs) {
    const diff = Math.abs(track.durationMs - cand.durationMs) / 1000;
    if (diff <= 2) score += 0.15;
    else if (diff <= 5) score += 0.07;
    else if (diff > 20) score -= 0.3;
    else if (diff > 10) score -= 0.12;
  }

  if (hasExtraVersionMarker(track.title, cand.title)) score -= 0.32;
  if (track.title && normalizeText(track.title).includes('live') && !normalizeText(cand.title).includes('live')) {
    score -= 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

/** 从候选里挑最佳；分数低于 0.3 视为没有可靠匹配 */
export function pickBest(track, candidates) {
  let best = null;
  let bestScore = 0;
  for (const cand of candidates ?? []) {
    const score = scoreCandidate(track, cand);
    if (score > bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  return best && bestScore >= 0.3 ? { cand: best, score: bestScore } : null;
}

/** 搜索关键字：歌名 + 主要歌手（去掉版本括号） */
export function searchQuery(track) {
  const title = baseTitle(track.title) || normalizeText(track.title);
  const artist = normalizeArtist(track.artist)[0] ?? '';
  return `${title} ${artist}`.trim();
}

async function fetchJson(url, { timeoutMs = 8000, referer = QQ_REFERER, cookie } = {}) {
  const headers = { referer, 'user-agent': UA, accept: 'application/json,text/plain,*/*' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 老接口偶尔返回 JSONP 包裹
    const m = text.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
    if (m) return JSON.parse(m[1]);
    throw new Error('响应不是 JSON');
  }
}

/**
 * 在 QQ 音乐曲库里搜索候选。
 * @returns {Promise<Array<{songmid:string,songid:number,title:string,artist:string,album:string,durationMs:number}>>}
 */
export async function searchQQMusic(track, { timeoutMs = 8000 } = {}) {
  const q = searchQuery(track);
  if (!q) return [];
  const url =
    'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&n=10&p=1&remoteplace=txt.yqq.top&t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=0&w=' +
    encodeURIComponent(q);
  const json = await fetchJson(url, { timeoutMs });
  const list = json?.data?.song?.list ?? [];
  return list.map((s) => ({
    songmid: String(s.songmid ?? s.songMid ?? ''),
    songid: Number(s.songid ?? 0) || 0,
    title: decodeEntities(s.songname ?? s.songName ?? ''),
    artist: (Array.isArray(s.singer) ? s.singer.map((x) => decodeEntities(x.name ?? '')).join('/') : '') || '',
    album: decodeEntities(s.albumname ?? s.albumName ?? ''),
    durationMs: (Number(s.interval) || 0) * 1000,
  }));
}

function b64decode(s) {
  if (!s) return '';
  try {
    return Buffer.from(String(s), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 拉取某首 QQ 音乐的 LRC（含翻译）。
 * @returns {Promise<{ lrc:string, trans:string, roma:string } | null>}
 */
export async function fetchQQLyric(songmid, songid = 0, { timeoutMs = 8000 } = {}) {
  if (!songmid) return null;
  const payload = {
    comm: { ct: 24, cv: 0 },
    req: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: { songMID: songmid, songID: Number(songid) || 0 },
    },
  };
  const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' + encodeURIComponent(JSON.stringify(payload));
  const json = await fetchJson(url, { timeoutMs });
  const data = json?.req?.data;
  if (!data) return null;
  const lrc = b64decode(data.lyric);
  if (!lrc.trim()) return null;
  return { lrc, trans: b64decode(data.trans), roma: b64decode(data.roma) };
}

function neteaseCachePath(songId) {
  const local = path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'NetEase', 'CloudMusic', 'webdata', 'lyric', String(songId));
}

function readNetEaseLocalLyric(songId) {
  try {
    const p = neteaseCachePath(songId);
    if (!existsSync(p)) return null;
    const json = JSON.parse(readFileSync(p, 'utf8'));
    if (json.pureMusic || json.nolyric || json.uncollected) return { lrc: '', trans: '', pure: true, cached: true };
    const lrc = String(json?.lrc?.lyric ?? '');
    if (!lrc.trim()) return null;
    return { lrc, trans: String(json?.tlyric?.lyric ?? ''), pure: false, cached: true };
  } catch {
    return null;
  }
}

/**
 * 网易云曲库搜索（公开 Web 接口）。
 * @returns {Promise<Array<{songId:string,title:string,artist:string,album:string,durationMs:number}>>}
 */
export async function searchNetEase(track, { timeoutMs = 8000 } = {}) {
  const q = searchQuery(track);
  if (!q) return [];
  const url =
    'https://music.163.com/api/search/get/web?csrf_token=&type=1&offset=0&total=false&limit=10&s=' +
    encodeURIComponent(q);
  const json = await fetchJson(url, { timeoutMs, referer: NETEASE_REFERER, cookie: NETEASE_COOKIE });
  const songs = json?.result?.songs ?? [];
  return songs.map((s) => ({
    songId: String(s.id ?? ''),
    title: String(s.name ?? ''),
    artist: Array.isArray(s.artists) ? s.artists.map((a) => String(a?.name ?? '')).filter(Boolean).join('/') : '',
    album: String(s?.album?.name ?? ''),
    durationMs: Number(s.duration) || 0,
  }));
}

/**
 * 按网易云 songId 取歌词（本地缓存优先，其次公开 API）。
 * @returns {Promise<{lrc:string,trans:string,pure:boolean,cached:boolean} | null>}
 */
export async function fetchNetEaseLyricById(songId, { timeoutMs = 8000 } = {}) {
  if (!songId) return null;
  const local = readNetEaseLocalLyric(songId);
  if (local) return local;
  const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(songId)}&lv=-1&kv=1&tv=-1`;
  const json = await fetchJson(url, { timeoutMs, referer: NETEASE_REFERER, cookie: NETEASE_COOKIE });
  if (json?.pureMusic || json?.nolyric || json?.uncollected) {
    return { lrc: '', trans: '', pure: true, cached: false };
  }
  const lrc = String(json?.lrc?.lyric ?? '');
  if (!lrc.trim()) return null;
  return { lrc, trans: String(json?.tlyric?.lyric ?? ''), pure: false, cached: false };
}

/** 按 songId 取网易云曲目详情（日志只给了 songId 时用） */
export async function fetchNetEaseSongDetail(songId, { timeoutMs = 8000 } = {}) {
  if (!songId) return null;
  const url = `https://music.163.com/api/song/detail?ids=%5B${encodeURIComponent(songId)}%5D`;
  const json = await fetchJson(url, { timeoutMs, referer: NETEASE_REFERER, cookie: NETEASE_COOKIE });
  const song = json?.songs?.[0];
  if (!song) return null;
  return {
    songId: String(song.id ?? songId),
    title: String(song.name ?? ''),
    artist: Array.isArray(song.artists)
      ? song.artists.map((a) => String(a?.name ?? '')).filter(Boolean).join('/')
      : '',
    album: String(song?.album?.name ?? ''),
    durationMs: Number(song.duration) || 0,
  };
}

/** lrclib 兜底（QQ 接口失效/搜不到时） */
export async function fetchLrclib(track, { timeoutMs = 6000 } = {}) {
  try {
    const u = new URL('https://lrclib.net/api/search');
    u.searchParams.set('track_name', String(track.title ?? ''));
    u.searchParams.set('artist_name', String(track.artist ?? ''));
    const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'dsh-pet-qqmusic/1.0' } });
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      const lrc = item?.syncedLyrics;
      if (typeof lrc === 'string' && lrc.includes('[')) return { lrc, trans: '', roma: '' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 完整取词流程：
 *   - QQ 播放：QQ 搜索 → 取 LRC；失败回落网易云 → lrclib
 *   - 网易云播放：优先按 songId 取词（本地缓存/API），否则网易云搜索；失败回落 QQ → lrclib
 *
 * @param {{title:string, artist:string, album?:string, durationMs?:number, songId?:string, player?:string}} track
 * @param {{timeoutMs?:number, player?:'qq'|'netease', songId?:string}} [options]
 * @returns {Promise<
 *   | { ok:true, source:'qq'|'netease'|'netease-cache'|'lrclib', matched:object, lrc:string, lines:Array<{t:number,text:string,trans?:string}>, instrumental:boolean }
 *   | { ok:false, reason:'no-track'|'not-found'|'network'|'empty', message?:string }
 * >}
 */
export async function resolveLyrics(track, { timeoutMs = 8000, player = 'qq', songId = '' } = {}) {
  if (!track || (!track.title && !songId)) return { ok: false, reason: 'no-track' };
  let lastError = '';

  const finish = (source, raw, matched, cached = false) => {
    if (raw.pure) {
      return { ok: true, source: cached ? `${source}-cache` : source, matched, lrc: '', lines: [], instrumental: true };
    }
    let lines = parseLrc(raw.lrc).lines;
    if (raw.trans) lines = mergeTranslation(lines, raw.trans);
    lines = stripLeadingCredits(lines, track);
    if (isInstrumental(lines)) {
      return { ok: true, source, matched, lrc: raw.lrc, lines: [], instrumental: true };
    }
    if (!lines.length) return null;
    return { ok: true, source: cached ? `${source}-cache` : source, matched, lrc: raw.lrc, lines, instrumental: false };
  };

  const tryQQ = async () => {
    if (!track.title) return null;
    const candidates = await searchQQMusic(track, { timeoutMs });
    const best = pickBest(track, candidates);
    if (!best) return null;
    const raw = await fetchQQLyric(best.cand.songmid, best.cand.songid, { timeoutMs });
    if (!raw) return null;
    return finish('qq', raw, { ...best.cand, score: best.score });
  };

  const tryNetEase = async () => {
    // 有 songId：直接按 id 取词，避免同名版本错配
    if (songId) {
      let meta = {
        songId: String(songId),
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        durationMs: track.durationMs || 0,
        score: 0,
      };
      if (!meta.title) {
        // 详情接口失败不应阻断按 songId 取词：歌词接口本身可能仍然可用
        try {
          const detail = await fetchNetEaseSongDetail(songId, { timeoutMs });
          if (detail) meta = { ...detail, score: 0 };
        } catch {
          /* detail is optional metadata */
        }
      }
      const raw = await fetchNetEaseLyricById(songId, { timeoutMs });
      if (raw) {
        const r = finish('netease', raw, meta, raw.cached);
        if (r) return r;
      }
    }
    if (!track.title) return null;
    const candidates = await searchNetEase(track, { timeoutMs });
    const best = pickBest(track, candidates);
    if (!best) return null;
    const raw = await fetchNetEaseLyricById(best.cand.songId, { timeoutMs });
    if (!raw) return null;
    return finish('netease', raw, { ...best.cand, score: best.score }, raw.cached);
  };

  const order = player === 'netease' ? [tryNetEase, tryQQ] : [tryQQ, tryNetEase];
  for (const provider of order) {
    try {
      const result = await provider();
      if (result) return result;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  // 兜底：lrclib（国内网络可能不可达，失败就继续返回错误）
  if (track.title) {
    const fallback = await fetchLrclib(track, { timeoutMs: Math.min(timeoutMs, 6000) });
    if (fallback) {
      const r = finish('lrclib', fallback, {
        songmid: '',
        songid: 0,
        songId: '',
        title: track.title,
        artist: track.artist ?? '',
        album: track.album ?? '',
        durationMs: track.durationMs ?? 0,
        score: 0,
      });
      if (r) return r;
    }
  }

  return { ok: false, reason: 'not-found', message: lastError };
}

/** 缓存键：播放器 / songId / 歌名 / 歌手 / 专辑 / 时长；同一首歌跨重启命中 */
export function cacheKey(track) {
  // 网易云有 songId 时以 id 为准：日志刚启动时可能只给 id，稍后才补歌名，
  // 若把歌名/时长算进键，同一首歌会重复取词，缓存也永远命中不了。
  const raw =
    track.player === 'netease' && track.songId
      ? `netease|id|${track.songId}`
      : [
          track.player ?? '',
          track.songId ?? '',
          normalizeText(track.title),
          normalizeText(track.artist),
          normalizeText(track.album),
          Math.round((track.durationMs ?? 0) / 1000),
        ].join('|');
  // 不用 crypto：Node 自带，但纯函数测试里注入更麻烦；这里用 FNV-1a 32 位足够做缓存键
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
