/**
 * dsh-pet-qqmusic —— 宿主半侧。
 *
 * 职责：
 *   1. 看护 SMTC helper（lib/smtc-helper.exe），拿到 QQ 音乐当前的歌名/歌手/进度；
 *   2. 按「歌名 + 歌手 + 时长」在 QQ 音乐曲库匹配并拉 LRC（lib/lyrics.js），带磁盘缓存；
 *   3. 把「当前行 / 下一行 / 播放进度」通过 /dsh-pet-qqmusic/state.json 暴露给浏览器侧；
 *   4. 浏览器侧（lib/client.js）看到行变化后 POST 到 dsh-pet 的 /broadcast，把歌词写进桌宠气泡。
 *
 * 为什么歌词投喂放在浏览器侧而不是宿主：
 *   dsh-pet 的路由有 DSH 浏览器信任栅栏（401/403），宿主内部裸 HTTP 请求没有会话凭据；
 *   浏览器侧同源 fetch 天然带会话，是 dsh-pet 自己前端也在用的调用方式。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheKey, fetchNetEaseSongDetail, resolveLyrics } from './lyrics.js';
import { NetEaseElogWatcher } from './netease-elog.js';
import { SmtcWatcher } from './smtc.js';

const ROUTE = '/dsh-pet-qqmusic';
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const CACHE_MAX_FILES = 400;

const DEFAULTS = {
  /** 总开关：关掉后浏览器侧不再投喂（宿主仍可查看状态） */
  enabled: true,
  /** 目标桌宠 id；空 = dsh-pet 的当前桌宠（/pet 选中的那只，未选则第一只） */
  petId: '',
  /** 播放器：auto = 谁在播就用谁；qq / netease 强制指定 */
  player: 'auto',
  /** 气泡展示模式：
   *  - auto（默认）：web 桌宠在场时用自绘歌词气泡（不打断宠物动画），否则回落到 dsh-pet 投喂
   *  - overlay：只用自绘歌词气泡，绝不触发宠物说话/换动画（桌面模式小窗不显示）
   *  - bubble：走 dsh-pet 的 /broadcast（每行都会让宠物换一次说话动画） */
  displayMode: 'auto',
  /** 歌词提前量（毫秒）：正数让歌词更早出现，负数更晚。
   *  默认 600ms 是为了补偿 dsh-pet 气泡自身约 1 秒的状态轮询；
   *  觉得歌词太早调小、太晚调大（范围 ±5000）。 */
  offsetMs: 600,
  /** 每行歌词停留多久后补发一次，避免 dsh-pet 气泡 10 秒自动消失（0 = 不补发） */
  keepAliveSec: 8,
  /** 是否在切歌时先显示「歌名 - 歌手」 */
  showTrackInfo: true,
  /** 是否把翻译一起显示（有翻译时） */
  showTranslation: false,
  /** 气泡前缀，默认音符 */
  prefix: '♪ ',
  /** 没有 SMTC 时是否让桌宠提示一次（每 10 分钟最多一次） */
  hints: true,
  /** 调试日志 */
  debug: false,
};

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitizeConfig(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: o.enabled === undefined ? DEFAULTS.enabled : Boolean(o.enabled),
    petId: typeof o.petId === 'string' ? o.petId.trim().slice(0, 80) : DEFAULTS.petId,
    player: ['auto', 'qq', 'netease'].includes(o.player) ? o.player : DEFAULTS.player,
    displayMode: ['auto', 'overlay', 'bubble'].includes(o.displayMode) ? o.displayMode : DEFAULTS.displayMode,
    offsetMs: clampInt(o.offsetMs, -5000, 5000, DEFAULTS.offsetMs),
    keepAliveSec: clampInt(o.keepAliveSec, 0, 60, DEFAULTS.keepAliveSec),
    showTrackInfo: o.showTrackInfo === undefined ? DEFAULTS.showTrackInfo : Boolean(o.showTrackInfo),
    showTranslation: o.showTranslation === undefined ? DEFAULTS.showTranslation : Boolean(o.showTranslation),
    prefix: typeof o.prefix === 'string' ? o.prefix.slice(0, 8) : DEFAULTS.prefix,
    hints: o.hints === undefined ? DEFAULTS.hints : Boolean(o.hints),
    debug: o.debug === undefined ? DEFAULTS.debug : Boolean(o.debug),
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    'content-length': body.length,
  });
  res.end(body);
}

/** 二分：最后一个 t <= target 的下标（没有则 -1） */
function findLineIndex(lines, target) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function trackKeyOf(track) {
  if (!track) return '';
  // 网易云有 songId 时以 id 为准：标题/时长后续补齐也不会误判成切歌
  if (track.songId) return [track.player || '', 'id', track.songId].join('|');
  return [track.player || '', track.title, track.artist, track.album, Math.round((track.durationMs || 0) / 3000)].join('|');
}

export class QQMusicService {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.root = path.join(this.home, 'dsh-pet-qqmusic');
    this.configPath = path.join(this.root, 'config.json');
    this.cacheDir = path.join(this.root, 'cache');
    this.config = options.config ? sanitizeConfig(options.config) : this._loadConfig();
    this.smtc = options.watcher ?? new SmtcWatcher({ intervalMs: 250, logger: console });
    this.netease = options.netease ?? new NetEaseElogWatcher({ logger: console });
    this.resolver = options.resolver ?? resolveLyrics;
    this.detailLookup = options.detailLookup ?? fetchNetEaseSongDetail;
    this.memoryCache = new Map();

    this.timer = null;
    this.lastTrackKey = '';
    this.track = null;
    this.lyrics = { status: 'idle', lines: [], source: '', instrumental: false, matched: null, error: '' };
    this.fetchSeq = 0;
    this.positionMs = 0;
    /** positionMs 的采样时刻；state() 用它把进度补到「请求这一刻」 */
    this.positionSampledAt = 0;
    this.durationMs = 0;
    this.playing = false;
    this.available = false;
    this.player = '';
    this.positionSource = '';
    this.songId = '';
    this.qqmusicRunning = null;
    this.cloudmusicRunning = null;
    this.neteaseReason = '';
    this.processTimer = null;
    this.lastHintCode = '';
    this.lastState = null;
    this.lastError = '';
  }

  start() {
    this._ensureDirs();
    this._pruneCache();
    this.smtc.start();
    this.netease.start();
    this.timer = setInterval(() => this._tick(), 200);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.processTimer = setInterval(() => this._checkProcesses(), 30_000);
    if (typeof this.processTimer.unref === 'function') this.processTimer.unref();
    this._checkProcesses();
    this._log('已启动：SMTC + 网易云 elog / 进程检测 30s');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.processTimer) clearInterval(this.processTimer);
    this.timer = null;
    this.processTimer = null;
    this.smtc.stop();
    this.netease.stop();
  }

  // ---- 配置 ----

  _ensureDirs() {
    try {
      mkdirSync(this.root, { recursive: true });
      mkdirSync(this.cacheDir, { recursive: true });
    } catch (e) {
      this._log('创建数据目录失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  _loadConfig() {
    try {
      if (existsSync(this.configPath)) {
        return sanitizeConfig(JSON.parse(readFileSync(this.configPath, 'utf8')));
      }
    } catch (e) {
      this._log('配置读取失败，使用默认值：' + (e instanceof Error ? e.message : String(e)));
    }
    return { ...DEFAULTS };
  }

  saveConfig(patch) {
    const next = sanitizeConfig({ ...this.config, ...(patch && typeof patch === 'object' ? patch : {}) });
    this.config = next;
    this._ensureDirs();
    const tmp = this.configPath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, this.configPath);
    } catch (e) {
      this._log('配置写入失败：' + (e instanceof Error ? e.message : String(e)));
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    return next;
  }

  // ---- 播放器进程（用于区分「没开客户端」和「没开 SMTC / 没日志」） ----

  _checkOneProcess(imageName, key) {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        this[key] = err ? null : String(stdout).toLowerCase().includes(imageName.toLowerCase());
      },
    );
  }

  _checkProcesses() {
    this._checkOneProcess('QQMusic.exe', 'qqmusicRunning');
    this._checkOneProcess('cloudmusic.exe', 'cloudmusicRunning');
  }

  // ---- 歌词缓存 ----

  _cachePath(key) {
    return path.join(this.cacheDir, key + '.json');
  }

  _readCache(key) {
    const mem = this.memoryCache.get(key);
    if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem;
    try {
      const p = this._cachePath(key);
      if (!existsSync(p)) return null;
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (!data || data.v !== 1 || Date.now() - Number(data.at || 0) > CACHE_TTL_MS) return null;
      this.memoryCache.set(key, data);
      return data;
    } catch {
      return null;
    }
  }

  _writeCache(key, value) {
    const data = { v: 1, at: Date.now(), ...value };
    this.memoryCache.set(key, data);
    if (this.memoryCache.size > 80) {
      const oldest = [...this.memoryCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.memoryCache.delete(oldest[0]);
    }
    try {
      this._ensureDirs();
      const p = this._cachePath(key);
      const tmp = p + '.tmp';
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, p);
    } catch {
      /* 缓存写失败不影响主流程 */
    }
  }

  _pruneCache() {
    try {
      if (!existsSync(this.cacheDir)) return;
      const files = [];
      for (const name of readdirSync(this.cacheDir)) {
        if (!name.endsWith('.json')) continue;
        const p = path.join(this.cacheDir, name);
        try {
          files.push({ p, m: statSync(p).mtimeMs });
        } catch {
          /* ignore */
        }
      }
      files.sort((a, b) => b.m - a.m);
      for (const f of files.slice(CACHE_MAX_FILES)) {
        try {
          unlinkSync(f.p);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ---- 主循环 ----

  _selectSession() {
    let qq = null;
    let ne = null;
    try {
      const snap = this.smtc.getState();
      if (snap && snap.available && snap.session) {
        qq = { ...snap.session, player: snap.session.player || 'qq', positionSource: snap.session.positionSource || 'smtc' };
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    try {
      const snap = this.netease.getState();
      if (snap && snap.available && snap.session) {
        ne = { ...snap.session, player: 'netease', positionSource: 'elog' };
      } else {
        this.neteaseReason = snap?.reason || '';
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }

    // 进程已经退出就忽略残留会话（elog / SMTC 都可能留下最后一条状态）
    if (qq && this.qqmusicRunning === false) qq = null;
    if (ne && this.cloudmusicRunning === false) ne = null;

    const forced = this.config.player;
    if (forced === 'qq') return qq;
    if (forced === 'netease') return ne;
    if (qq && ne) {
      if (qq.playing && !ne.playing) return qq;
      if (ne.playing && !qq.playing) return ne;
      if (qq.playing && ne.playing) {
        // 两个都在播：用最近更新的那个；事件时间相同则优先 QQ
        return Number(ne.lastUpdatedMs) > Number(qq.lastUpdatedMs) ? ne : qq;
      }
      return qq;
    }
    return qq || ne;
  }

  _tick() {
    const s = this._selectSession();
    this.available = Boolean(s);
    if (!this.available) {
      this.playing = false;
      this.player = '';
      this.positionSource = '';
      this.songId = '';
      this.positionSampledAt = 0;
      return;
    }

    this.player = s.player || 'qq';
    this.positionSource = s.positionSource || (this.player === 'netease' ? 'elog' : 'smtc');
    this.songId = s.songId ? String(s.songId) : '';
    this.playing = Boolean(s.playing);
    this.positionMs = Math.max(0, Number(s.positionMs) || 0);
    this.positionSampledAt = Date.now();
    this.durationMs = Math.max(0, Number(s.durationMs) || 0);

    const track = {
      title: s.title || '',
      artist: s.artist || '',
      album: s.album || '',
      durationMs: this.durationMs,
      songId: this.songId,
      player: this.player,
    };
    const key = trackKeyOf(track);
    if (key !== this.lastTrackKey) {
      this.lastTrackKey = key;
      this.track = track;
      this._beginLyrics(track, key, this.player, this.songId);
    } else if (this.track) {
      this.track.durationMs = this.durationMs || this.track.durationMs;
      this.track.title = this.track.title || track.title;
      this.track.artist = this.track.artist || track.artist;
      this.track.album = this.track.album || track.album;
    }
  }

  /** elog 只给了 songId（native-load）时，补一次网易云曲目详情 */
  _loadNeteaseDetail(track, key) {
    this.detailLookup(track.songId)
      .then((detail) => {
        if (!detail || this.lastTrackKey !== key) return;
        if (!this.track) return;
        this.track.title = detail.title || this.track.title;
        this.track.artist = detail.artist || this.track.artist;
        this.track.album = detail.album || this.track.album;
        this.track.durationMs = detail.durationMs || this.track.durationMs;
        this.durationMs = this.track.durationMs;
        this._log(`网易云曲目详情：${this.track.title} - ${this.track.artist}`);
      })
      .catch(() => {});
  }

  /**
   * 用取词结果里的曲目信息补齐 NetEase 的空标题。
   * elog 刚切歌时常常只有 songId；此时取词流程本来就会查一次详情，
   * 直接复用结果，避免再发一条 /song/detail 请求。
   */
  _applyMatchedTrack(matched, key, player) {
    if (!matched || !this.track || this.lastTrackKey !== key) return;
    if (player !== 'netease') return;
    if (matched.songId && this.track.songId && String(matched.songId) !== String(this.track.songId)) return;
    if (!this.track.title && matched.title) this.track.title = matched.title;
    if (!this.track.artist && matched.artist) this.track.artist = matched.artist;
    if (!this.track.album && matched.album) this.track.album = matched.album;
    if (!this.track.durationMs && matched.durationMs) {
      this.track.durationMs = matched.durationMs;
      this.durationMs = matched.durationMs;
    }
  }

  _beginLyrics(track, key, player = this.player || 'qq', songId = this.songId || '', { force = false } = {}) {
    const seq = ++this.fetchSeq;
    const cached = force ? null : this._readCache(cacheKey(track));
    if (cached && cached.track && cached.lines) {
      this.lyrics = {
        status: cached.instrumental ? 'instrumental' : 'ready',
        lines: Array.isArray(cached.lines) ? cached.lines : [],
        source: cached.source ?? 'cache',
        instrumental: Boolean(cached.instrumental),
        matched: cached.matched ?? null,
        error: '',
      };
      this._applyMatchedTrack(cached.matched, key, player);
      if (player === 'netease' && this.track && !this.track.title) this._loadNeteaseDetail(track, key);
      return;
    }
    this.lyrics = { status: 'loading', lines: [], source: '', instrumental: false, matched: null, error: '' };
    this.resolver(track, { player, songId })
      .then((res) => {
        if (seq !== this.fetchSeq) return; // 已经切歌，丢弃旧结果
        if (res.ok) {
          this.lyrics = {
            status: res.instrumental ? 'instrumental' : 'ready',
            lines: res.lines,
            source: res.source,
            instrumental: res.instrumental,
            matched: res.matched,
            error: '',
          };
          this._applyMatchedTrack(res.matched, key, player);
          this._writeCache(cacheKey(track), {
            track,
            source: res.source,
            matched: res.matched,
            lrc: res.lrc,
            lines: res.lines,
            instrumental: res.instrumental,
          });
          const label = track.title || this.track?.title || track.songId || '(未知曲目)';
          this._log(
            `取词成功：${label} - ${track.artist}（${player} / ${res.source}，${res.lines.length} 行${res.instrumental ? '，纯音乐' : ''}）`,
          );
        } else {
          this.lyrics = {
            status: 'error',
            lines: [],
            source: '',
            instrumental: false,
            matched: null,
            error: res.message || res.reason || '取词失败',
          };
          const label = track.title || this.track?.title || track.songId || '(未知曲目)';
          this._log(`取词失败：${label} - ${track.artist}：${this.lyrics.error}`);
        }
        // 取词失败 / 只拿到 id 时，仍补一次曲目详情，保证气泡和状态里有歌名
        if (player === 'netease' && this.track && !this.track.title) this._loadNeteaseDetail(track, key);
      })
      .catch((e) => {
        if (seq !== this.fetchSeq) return;
        this.lyrics = {
          status: 'error',
          lines: [],
          source: '',
          instrumental: false,
          matched: null,
          error: e instanceof Error ? e.message : String(e),
        };
        if (player === 'netease' && this.track && !this.track.title) this._loadNeteaseDetail(track, key);
      });
  }

  refreshLyrics() {
    if (!this.track) return false;
    const key = this.lastTrackKey || trackKeyOf(this.track);
    // 只取消在途请求；不要清空 lastTrackKey，否则下一 tick 会把它当成切歌再取一次。
    this._beginLyrics(this.track, key, this.track.player || this.player, this.track.songId || this.songId, {
      force: true,
    });
    return true;
  }

  // ---- 对外状态 ----

  _lineAt(index) {
    const lines = this.lyrics.lines;
    if (index < 0 || index >= lines.length) return null;
    const cur = lines[index];
    const next = lines[index + 1] ?? null;
    return {
      index,
      text: cur.text,
      t: cur.t,
      ...(cur.trans ? { trans: cur.trans } : {}),
      endMs: next ? next.t : this.durationMs || cur.t,
    };
  }

  _hint() {
    if (this.available) return null;
    if (!this.config.hints) return null;
    const preferNetease = this.config.player === 'netease' || (this.cloudmusicRunning === true && this.qqmusicRunning !== true);
    if (preferNetease || this.cloudmusicRunning === true) {
      if (this.neteaseReason === 'elog-missing') {
        return {
          code: 'netease-elog',
          text: '没找到网易云的 cloudmusic.elog；网易云 3.0+ 启动并播放过一次后就能读到',
        };
      }
      return { code: 'netease-idle', text: '网易云还没在播放呢' };
    }
    if (this.qqmusicRunning === true) {
      return {
        code: 'smtc-off',
        text: 'QQ音乐没开 SMTC：设置 → 常规设置 → 通知 → 显示系统媒体传输控制（SMTC）',
      };
    }
    if (this.cloudmusicRunning === true) {
      return { code: 'netease-idle', text: '网易云还没在播放呢' };
    }
    if (this.qqmusicRunning === false && this.cloudmusicRunning === false) {
      return { code: 'not-running', text: 'QQ音乐 / 网易云都还没打开呢' };
    }
    return null;
  }

  state() {
    const now = Date.now();
    // 进度补到「请求这一刻」：_tick 是 200ms 内的一次快照，直接用它会让
    // 当前行最多晚 200ms 才切换，客户端排程下一行也会偏晚。
    let positionMs = this.positionMs;
    if (this.available && this.playing && this.positionSampledAt > 0) {
      positionMs += Math.max(0, now - this.positionSampledAt);
    }
    if (this.durationMs > 0) positionMs = Math.min(positionMs, this.durationMs);
    positionMs = Math.max(0, positionMs);

    const index =
      this.available && this.lyrics.status === 'ready' && this.lyrics.lines.length
        ? findLineIndex(this.lyrics.lines, positionMs + this.config.offsetMs)
        : -1;
    const line = index >= 0 ? this._lineAt(index) : null;
    const nextLine = index >= 0 ? this._lineAt(index + 1) : null;
    return {
      ok: true,
      at: now,
      enabled: this.config.enabled,
      available: this.available,
      playing: this.playing,
      player: this.player,
      positionSource: this.positionSource,
      songId: this.songId,
      track: this.track,
      positionMs: Math.round(positionMs),
      positionAt: now,
      durationMs: Math.round(this.durationMs),
      line,
      nextLine,
      lyrics: {
        status: this.lyrics.status,
        source: this.lyrics.source,
        count: this.lyrics.lines.length,
        instrumental: this.lyrics.instrumental,
        matched: this.lyrics.matched,
        error: this.lyrics.error,
      },
      qqmusicRunning: this.qqmusicRunning,
      cloudmusicRunning: this.cloudmusicRunning,
      neteaseReason: this.neteaseReason,
      hint: this._hint(),
      updatedAt: now,
      config: { ...this.config },
    };
  }

  // ---- 路由 ----

  async handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith(ROUTE)) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const rest = url.pathname.slice(ROUTE.length) || '/';
      const method = (req.method ?? 'GET').toUpperCase();

      if (rest === '/' || rest === '') {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return sendHtml(res, 200, this._debugPage());
      }

      if (rest === '/health') {
        return sendJson(res, 200, {
          ok: true,
          name: 'dsh-pet-qqmusic',
          available: this.available,
          player: this.player,
          positionSource: this.positionSource,
          helper: {
            running: Boolean(this.smtc.child),
            missing: this.smtc.helperMissing,
            error: this.smtc.lastError,
          },
          netease: {
            path: this.netease.path,
            reason: this.neteaseReason,
            lastError: this.netease.lastError,
          },
          qqmusicRunning: this.qqmusicRunning,
          cloudmusicRunning: this.cloudmusicRunning,
          lyricsStatus: this.lyrics.status,
        });
      }

      if (rest === '/state.json') {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return sendJson(res, 200, this.state());
      }

      if (rest === '/config.json') {
        if (method === 'GET') return sendJson(res, 200, { ok: true, config: this.config });
        if (method === 'PUT' || method === 'POST') {
          let parsed;
          try {
            parsed = JSON.parse((await readBody(req)) || '{}');
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          }
          const config = this.saveConfig(parsed);
          return sendJson(res, 200, { ok: true, config });
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      }

      if (rest === '/refresh') {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        const ok = this.refreshLyrics();
        return sendJson(res, 200, { ok, state: this.state() });
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  _debugPage() {
    return `<!doctype html>
<meta charset="utf-8">
<title>dsh-pet-qqmusic</title>
<style>
  body{font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif;max-width:920px;margin:32px auto;padding:0 18px;color:#1f2937;background:#f8fafc}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#64748b;margin-bottom:20px}
  pre{background:#0f172a;color:#e2e8f0;padding:16px;border-radius:10px;overflow:auto;font-size:12px;line-height:1.5}
  .tip{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;margin:14px 0;color:#1e40af}
  code{background:#e2e8f0;padding:1px 5px;border-radius:4px}
  button{padding:6px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer}
</style>
<h1>🐋 鲸歌 · 歌词同步调试面板</h1>
<div class="sub">dsh-pet-qqmusic 宿主路由 ${ROUTE}</div>
<div class="tip">
  1) QQ 音乐：<code>设置 → 常规设置 → 通知 → 显示系统媒体传输控制（SMTC）</code>；<br>
  2) 网易云：3.0+ 直接播放即可（读取本地 <code>cloudmusic.elog</code>，不需要插件）；<br>
  3) 看下面的 <code>player</code> / <code>line</code>，浏览器侧会把这些行投喂给 dsh-pet 的气泡。
</div>
<p><button onclick="refresh()">重新取词</button> <button onclick="load()">刷新状态</button></p>
<pre id="out">加载中…</pre>
<script>
async function load(){
  const r = await fetch('${ROUTE}/state.json', {cache:'no-store'});
  const j = await r.json();
  document.getElementById('out').textContent = JSON.stringify(j, null, 2);
}
async function refresh(){
  await fetch('${ROUTE}/refresh', {method:'POST'});
  await load();
}
load(); setInterval(load, 1500);
</script>`;
  }

  _log(msg) {
    if (this.config.debug) console.log('[dsh-pet-qqmusic] ' + msg);
  }
}

export const name = 'dsh-pet-qqmusic';
export const inject = ['webServer'];

export function apply(ctx) {
  const service = new QQMusicService(ctx);
  ctx.effect(() => {
    service.start();
    return () => service.stop();
  }, 'dsh-pet-qqmusic: lifecycle');
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => service.handle(req, res),
      }),
    'dsh-pet-qqmusic: route',
  );
  console.log('[dsh-pet-qqmusic] 已加载：' + ROUTE);
}
