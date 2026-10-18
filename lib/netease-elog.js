/**
 * 网易云音乐播放状态（无 SMTC / 无插件版）。
 *
 * 背景：
 *   Win32 网易云客户端**不注册** Windows 新版 SMTC 会话（GetSessions() 恒为 0），
 *   社区方案通常要装 BetterNCM + InfLink-rs 才能把播放状态发布到 SMTC。
 *   但网易云 3.0+ 会把播放事件写进 `%LOCALAPPDATA%\NetEase\CloudMusic\cloudmusic.elog`，
 *   日志用一套逐字节替换编码，里面包含：
 *     - checkPlayPrivilege / playOneTrackInPlayingList → 当前歌曲（id/name/artists/album/duration）
 *     - native播放资源load完成 → 真正出声点
 *     - setPlayingPosition → 拖拽 seek 后的真实位置（秒）
 *     - native播放state → 1=播放 2=暂停
 *
 *   本模块移植了社区 `netease-cloudmusic-detector` 的解码表与状态机（MIT），
 *   用 Node 直接读日志，从而实现**不需要注入、不需要 SMTC、能感知 seek** 的网易云进度源。
 *
 * 隐私：
 *   只解析歌名/歌手/专辑/时长/songId/进度；日志里的 musicurl（带签名）不会进入状态、
 *   不会落盘、不会上传。日志只在本机读。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 逐字节解码表：由 netease-cloudmusic-detector 的 _build_decode_table 移植 */
const DECODE_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    const high = b >> 4;
    const low = b & 0x0f;
    const hex = ((high ^ ((low + 8) % 16)) % 16) | 0;
    table[b] = (hex * 16 + (b >> 6) * 4 + ((~high) & 3)) & 0xff;
  }
  return table;
})();

/** 解码 cloudmusic.elog 的字节流 */
export function decodeElog(buffer) {
  const out = Buffer.allocUnsafe(buffer.length);
  for (let i = 0; i < buffer.length; i++) out[i] = DECODE_TABLE[buffer[i]];
  return out.toString('utf8');
}

/** 反向编码（只用于测试/造样本；正常运行时不做） */
export function encodeElog(text) {
  const inverse = new Int16Array(256).fill(-1);
  for (let b = 0; b < 256; b++) inverse[DECODE_TABLE[b]] = b;
  const src = Buffer.from(String(text), 'utf8');
  const out = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = inverse[src[i]];
    if (v < 0) throw new Error('elog encode: no inverse byte for ' + src[i]);
    out[i] = v;
  }
  return out;
}

const HEADER_RE =
  /^\[(\d+):(\d+):(\d{4}\/\d{6}):(\d+):([A-Z]+):([\w.\-]+)\((\d+)\)\]\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

/** 把 header 里的系统 uptime(ms) 换回事件发生的墙钟时间 */
export function parseElogHeader(line) {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  const ts = Number(m[4]) || 0;
  const datetimeMs = Date.parse(String(m[8]).replace(' ', 'T'));
  const nowUptime = os.uptime() * 1000;
  let eventTimeMs = Date.now() - (nowUptime - ts);
  // uptime 与日志不匹配（跨重启/日志被拷贝）时退回秒级墙钟
  if (!Number.isFinite(eventTimeMs) || Math.abs(eventTimeMs - datetimeMs) > 12 * 3600 * 1000) {
    eventTimeMs = Number.isFinite(datetimeMs) ? datetimeMs : Date.now();
  }
  return { eventTimeMs, datetimeMs, ts };
}

function extractJson(line) {
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(line.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 把日志里的 track JSON 归一成统一曲目 */
export function makeTrack(data) {
  if (!data || typeof data !== 'object') return null;
  const t = data.track && typeof data.track === 'object' ? data.track : data;
  const album = t.album && typeof t.album === 'object' ? t.album : {};
  const artists = Array.isArray(t.artists) ? t.artists : [];
  return {
    songId: t.id === undefined || t.id === null ? '' : String(t.id),
    title: String(t.name ?? ''),
    artist: artists.map((a) => String(a?.name ?? '')).filter(Boolean).join('/'),
    album: String(album.name ?? t.albumName ?? ''),
    durationMs: Number(t.duration) || 0,
  };
}

/**
 * 解析一行日志。
 * @returns {null | {type:'exit'|'set-playing'|'play-one'|'native-load'|'seek'|'status', eventTimeMs:number, data?:object, positionSec?:number, status?:number, songId?:string}}
 */
export function parseElogLine(line) {
  const header = parseElogHeader(line);
  if (!header) return null;
  const base = { eventTimeMs: header.eventTimeMs };

  if (line.includes('exitApp')) return { ...base, type: 'exit' };
  if (line.includes('"checkPlayPrivilege"')) {
    const data = extractJson(line);
    return data ? { ...base, type: 'set-playing', data } : null;
  }
  if (line.includes('"playOneTrackInPlayingList"')) {
    const data = extractJson(line);
    return data ? { ...base, type: 'play-one', data } : null;
  }
  if (line.includes('"setPlayingPosition"')) {
    const m = /"setPlayingPosition"\s*,\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (!m) return null;
    return { ...base, type: 'seek', positionSec: Number(m[1]) || 0 };
  }
  if (line.includes('"native') && line.includes('state"')) {
    const m = /"native[^"]*state"\s*,\s*(\d+)/.exec(line);
    if (!m) return null;
    return { ...base, type: 'status', status: Number(m[1]) };
  }
  if (line.includes('"native') && line.includes('load') && line.includes('"songId"')) {
    const data = extractJson(line);
    if (!data) return null;
    return { ...base, type: 'native-load', data, songId: data.songId ? String(data.songId) : '' };
  }
  return null;
}

/** 默认 elog 路径（网易云 3.0+） */
export function defaultElogPath() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'NetEase', 'CloudMusic', 'cloudmusic.elog');
}

export class NetEaseElogWatcher {
  constructor(options = {}) {
    this.path = options.path || defaultElogPath();
    this.pollMs = Math.max(100, Math.min(2000, Number(options.pollMs) || 300));
    this.logger = options.logger ?? console;
    this.timer = null;
    this.stopped = false;
    this.offset = 0;
    this.carry = '';
    this.loaded = false;
    this.lastError = '';
    this.state = {
      songId: '',
      track: null,
      pausing: true,
      positionSec: 0,
      relativeTime: 0,
      anchored: false,
      lastEventAt: 0,
    };
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.timer) return;
    this._tick();
    this.timer = setInterval(this._tick, this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getState() {
    const s = this.state;
    if (!s.songId && !s.track) {
      return {
        available: false,
        session: null,
        reason: this.lastError ? 'error' : existsSync(this.path) ? 'no-session' : 'elog-missing',
        at: Date.now(),
      };
    }
    const now = Date.now();
    let pos = s.pausing ? s.positionSec : (now - s.relativeTime) / 1000;
    const dur = (s.track?.durationMs ?? 0) / 1000;
    if (dur > 0) pos = Math.min(pos, dur);
    pos = Math.max(0, pos);
    const track = s.track ?? { songId: s.songId, title: '', artist: '', album: '', durationMs: 0 };
    return {
      available: true,
      session: {
        source: 'cloudmusic.exe',
        player: 'netease',
        title: track.title,
        artist: track.artist,
        album: track.album,
        status: s.pausing ? 'Paused' : 'Playing',
        playing: !s.pausing,
        positionMs: Math.round(pos * 1000),
        durationMs: Math.round(track.durationMs || dur * 1000),
        lastUpdatedMs: s.lastEventAt || now,
        songId: track.songId || s.songId,
        positionSource: 'elog',
      },
      reason: 'ok',
      at: now,
    };
  }

  _reset() {
    this.state = {
      songId: '',
      track: null,
      pausing: true,
      positionSec: 0,
      relativeTime: 0,
      anchored: false,
      lastEventAt: 0,
    };
  }

  _setTrack(track, pausing, eventTimeMs) {
    this.state.songId = track.songId || '';
    this.state.track = track;
    this.state.pausing = Boolean(pausing);
    this.state.positionSec = 0;
    this.state.relativeTime = pausing ? 0 : eventTimeMs;
    this.state.anchored = false;
  }

  _tick() {
    if (this.stopped) return;
    let st;
    try {
      st = statSync(this.path);
    } catch {
      if (this.loaded) this._reset();
      this.loaded = false;
      this.offset = 0;
      this.carry = '';
      this.lastError = existsSync(this.path) ? '' : 'elog-missing';
      return;
    }
    if (!this.loaded || st.size < this.offset) {
      this._preload();
      return;
    }
    if (st.size === this.offset) return;
    try {
      const fd = openSync(this.path, 'r');
      try {
        const len = st.size - this.offset;
        const buf = Buffer.allocUnsafe(len);
        readSync(fd, buf, 0, len, this.offset);
        this.offset = st.size;
        this._ingest(buf, false);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  _preload() {
    let buf;
    try {
      buf = readFileSync(this.path);
    } catch {
      this.lastError = 'elog-missing';
      return;
    }
    this.offset = buf.length;
    this.loaded = true;
    this.carry = '';
    this.lastError = '';
    this._reset();
    const text = decodeElog(buf);
    const lines = text.split('\n');
    const events = [];
    for (const line of lines) {
      const ev = parseElogLine(line);
      if (ev) events.push(ev);
    }
    // 倒序找最近一次退出 / 切歌 / 出声
    let trackEv = null;
    let trackIdx = -1;
    let exitIdx = -1;
    let loadEv = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type === 'exit') {
        exitIdx = i;
        break;
      }
      if (!trackEv && (ev.type === 'set-playing' || ev.type === 'play-one')) {
        const track = makeTrack(ev.data);
        if (track && track.songId) {
          trackEv = ev;
          trackIdx = i;
        }
        continue;
      }
      if (!trackEv && !loadEv && ev.type === 'native-load' && ev.songId) loadEv = ev;
    }
    if (exitIdx > trackIdx && exitIdx >= 0) {
      this._reset();
      return;
    }
    if (trackEv) {
      const track = makeTrack(trackEv.data);
      this._setTrack(track, trackEv.type === 'set-playing', trackEv.eventTimeMs);
      this.state.lastEventAt = trackEv.eventTimeMs;
      // 正序回放 seek / 状态
      let lastAction = trackEv.eventTimeMs;
      let pos = 0;
      let pausing = trackEv.type === 'set-playing';
      for (let i = trackIdx + 1; i < events.length; i++) {
        const ev = events[i];
        if (ev.type === 'seek') {
          pos = ev.positionSec;
          lastAction = ev.eventTimeMs;
        } else if (ev.type === 'status') {
          const offset = Math.max(0, (ev.eventTimeMs - lastAction) / 1000);
          lastAction = ev.eventTimeMs;
          pausing = ev.status === 2;
          if (pausing) pos += offset;
        }
      }
      this.state.pausing = pausing;
      if (pausing) {
        this.state.positionSec = pos;
        this.state.relativeTime = 0;
      } else {
        this.state.relativeTime = lastAction - pos * 1000;
      }
      this.state.lastEventAt = lastAction;
      return;
    }
    if (loadEv) {
      this.state.songId = loadEv.songId;
      this.state.track = { songId: loadEv.songId, title: '', artist: '', album: '', durationMs: 0 };
      this.state.pausing = false;
      this.state.relativeTime = loadEv.eventTimeMs;
      this.state.lastEventAt = loadEv.eventTimeMs;
    }
  }

  _ingest(buf, initial) {
    const text = decodeElog(buf);
    const joined = this.carry + text;
    const lines = joined.split('\n');
    this.carry = lines.pop() ?? '';
    for (const line of lines) this._handleLine(line);
  }

  _handleLine(line) {
    const ev = parseElogLine(line);
    if (!ev) return;
    this.lastEventAt = ev.eventTimeMs;
    const s = this.state;
    switch (ev.type) {
      case 'exit':
        this._reset();
        return;
      case 'set-playing': {
        const track = makeTrack(ev.data);
        if (!track || !track.songId) return;
        if (track.songId === s.songId) return;
        this._setTrack(track, true, ev.eventTimeMs);
        s.lastEventAt = ev.eventTimeMs;
        return;
      }
      case 'play-one': {
        const track = makeTrack(ev.data);
        if (!track || !track.songId) return;
        if (track.songId === s.songId) return;
        this._setTrack(track, false, ev.eventTimeMs);
        s.lastEventAt = ev.eventTimeMs;
        return;
      }
      case 'native-load': {
        if (!ev.songId) return;
        if (ev.songId === s.songId) {
          // 同曲真正出声点：校正缓冲期造成的进度领先
          const posNow = s.pausing ? s.positionSec : (ev.eventTimeMs - s.relativeTime) / 1000;
          const ended = s.track && s.track.durationMs > 0 && posNow >= s.track.durationMs / 1000 - 0.25;
          if (!s.pausing && (!s.anchored || ended)) {
            s.relativeTime = ev.eventTimeMs;
            s.anchored = false;
          }
          return;
        }
        // 新歌但还没拿到曲目详情：先记住 songId，让上层按 id 取详情/歌词
        s.songId = ev.songId;
        s.track = { songId: ev.songId, title: '', artist: '', album: '', durationMs: 0 };
        s.pausing = false;
        s.relativeTime = ev.eventTimeMs;
        s.anchored = false;
        s.lastEventAt = ev.eventTimeMs;
        return;
      }
      case 'seek': {
        const pos = Math.max(0, Number(ev.positionSec) || 0);
        if (s.pausing) {
          s.positionSec = pos;
          s.relativeTime = 0;
        } else {
          s.relativeTime = ev.eventTimeMs - pos * 1000;
          s.positionSec = 0;
        }
        s.anchored = true;
        s.lastEventAt = ev.eventTimeMs;
        return;
      }
      case 'status': {
        const current = s.pausing ? s.positionSec : Math.max(0, (ev.eventTimeMs - s.relativeTime) / 1000);
        const pausing = ev.status === 2;
        s.pausing = pausing;
        if (pausing) {
          s.positionSec = current;
          s.relativeTime = 0;
        } else {
          s.relativeTime = ev.eventTimeMs - current * 1000;
          s.positionSec = 0;
        }
        s.anchored = true;
        s.lastEventAt = ev.eventTimeMs;
        return;
      }
      default:
        return;
    }
  }
}
