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
import { cacheKey, resolveLyrics } from './lyrics.js';
import { SmtcWatcher } from './smtc.js';

const ROUTE = '/dsh-pet-qqmusic';
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const CACHE_MAX_FILES = 400;

const DEFAULTS = {
  /** 总开关：关掉后浏览器侧不再投喂（宿主仍可查看状态） */
  enabled: true,
  /** 目标桌宠 id；空 = dsh-pet 的当前桌宠（/pet 选中的那只，未选则第一只） */
  petId: '',
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
  return [track.title, track.artist, track.album, Math.round((track.durationMs || 0) / 3000)].join('|');
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
    this.resolver = options.resolver ?? resolveLyrics;
    this.memoryCache = new Map();

    this.timer = null;
    this.lastTrackKey = '';
    this.track = null;
    this.lyrics = { status: 'idle', lines: [], source: '', instrumental: false, matched: null, error: '' };
    this.fetchSeq = 0;
    this.positionMs = 0;
    this.durationMs = 0;
    this.lineIndex = -1;
    this.playing = false;
    this.available = false;
    this.qqmusicRunning = null;
    this.processTimer = null;
    this.lastHintCode = '';
    this.lastState = null;
    this.lastError = '';
  }

  start() {
    this._ensureDirs();
    this._pruneCache();
    this.smtc.start();
    this.timer = setInterval(() => this._tick(), 200);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.processTimer = setInterval(() => this._checkQQMusicProcess(), 30_000);
    if (typeof this.processTimer.unref === 'function') this.processTimer.unref();
    this._checkQQMusicProcess();
    this._log('已启动：SMTC 轮询 300ms / 进程检测 30s');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.processTimer) clearInterval(this.processTimer);
    this.timer = null;
    this.processTimer = null;
    this.smtc.stop();
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

  // ---- QQ 音乐进程（用于区分「没开 QQ 音乐」和「没开 SMTC」） ----

  _checkQQMusicProcess() {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq QQMusic.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          this.qqmusicRunning = null;
          return;
        }
        this.qqmusicRunning = String(stdout).toLowerCase().includes('qqmusic.exe');
      },
    );
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

  _tick() {
    let snap;
    try {
      snap = this.smtc.getState();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.available = false;
      return;
    }
    this.available = Boolean(snap && snap.available && snap.session);
    if (!this.available) {
      this.playing = false;
      this.lineIndex = -1;
      return;
    }
    const s = snap.session;
    this.playing = Boolean(s.playing);
    this.positionMs = Math.max(0, Number(s.positionMs) || 0);
    this.durationMs = Math.max(0, Number(s.durationMs) || 0);

    const track = {
      title: s.title || '',
      artist: s.artist || '',
      album: s.album || '',
      durationMs: this.durationMs,
    };
    const key = trackKeyOf(track);
    if (key !== this.lastTrackKey) {
      this.lastTrackKey = key;
      this.track = track;
      this.lineIndex = -1;
      this._beginLyrics(track, key);
    } else if (this.track) {
      // 时长可能在 SMTC 首次上报时还是 0，后续补齐
      this.track.durationMs = this.durationMs || this.track.durationMs;
    }

    this._updateLine();
  }

  /** 歌词就绪/配置变化后立刻重算当前行（不等下一个 300ms tick） */
  _updateLine() {
    this.lineIndex =
      this.lyrics.status === 'ready' && this.lyrics.lines.length
        ? findLineIndex(this.lyrics.lines, this.positionMs + this.config.offsetMs)
        : -1;
  }

  _beginLyrics(track, key) {
    const seq = ++this.fetchSeq;
    const cached = this._readCache(cacheKey(track));
    if (cached && cached.track && cached.lines) {
      this.lyrics = {
        status: cached.instrumental ? 'instrumental' : 'ready',
        lines: Array.isArray(cached.lines) ? cached.lines : [],
        source: cached.source ?? 'cache',
        instrumental: Boolean(cached.instrumental),
        matched: cached.matched ?? null,
        error: '',
      };
      this._updateLine();
      return;
    }
    this.lyrics = { status: 'loading', lines: [], source: '', instrumental: false, matched: null, error: '' };
    this.resolver(track)
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
          this._writeCache(cacheKey(track), {
            track,
            source: res.source,
            matched: res.matched,
            lrc: res.lrc,
            lines: res.lines,
            instrumental: res.instrumental,
          });
          this._log(
            `取词成功：${track.title} - ${track.artist}（${res.source}，${res.lines.length} 行${res.instrumental ? '，纯音乐' : ''}）`,
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
          this._log(`取词失败：${track.title} - ${track.artist}：${this.lyrics.error}`);
        }
        this._updateLine();
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
        this._updateLine();
      });
  }

  refreshLyrics() {
    if (!this.track) return false;
    this.fetchSeq++; // 取消在途
    this.lastTrackKey = ''; // 强制下一 tick 重新取词
    this._beginLyrics(this.track, trackKeyOf(this.track));
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
    if (this.qqmusicRunning === true) {
      return {
        code: 'smtc-off',
        text: 'QQ音乐没开 SMTC：设置 → 常规设置 → 通知 → 显示系统媒体传输控制（SMTC）',
      };
    }
    if (this.qqmusicRunning === false) {
      return { code: 'not-running', text: 'QQ音乐还没打开呢' };
    }
    return null;
  }

  state() {
    const line = this.available && this.lineIndex >= 0 ? this._lineAt(this.lineIndex) : null;
    const nextLine = this.available && this.lineIndex >= 0 ? this._lineAt(this.lineIndex + 1) : null;
    return {
      ok: true,
      at: Date.now(),
      enabled: this.config.enabled,
      available: this.available,
      playing: this.playing,
      track: this.track,
      positionMs: Math.round(this.positionMs),
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
      hint: this._hint(),
      updatedAt: Date.now(),
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
          helper: {
            running: Boolean(this.smtc.child),
            missing: this.smtc.helperMissing,
            error: this.smtc.lastError,
          },
          qqmusicRunning: this.qqmusicRunning,
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
<h1>🐋 QQ 音乐歌词同步 · 调试面板</h1>
<div class="sub">dsh-pet-qqmusic 宿主路由 ${ROUTE}</div>
<div class="tip">
  1) 先在 QQ音乐 打开：<code>设置 → 常规设置 → 通知 → 显示系统媒体传输控制（SMTC）</code>；<br>
  2) 播放任意歌曲，下面的 <code>line</code> 会随进度变化；<br>
  3) 浏览器侧会把这些行投喂给 dsh-pet 的气泡。
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
