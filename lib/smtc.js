/**
 * SMTC 读取器（Node 侧）。
 *
 * 真正的 WinRT 调用在 lib/smtc-helper.cs（C#）：Node 不能直接调用 Windows Runtime。
 * 为了通过 DSH STORE 的固定源码扫描，仓库不再携带预编译 exe；首次启动时用
 * Windows 自带的 csc.exe 把随包源码编译到 $DSH_HOME/dsh-pet-qqmusic/bin/。
 * 子进程按行输出 JSON，本模块负责：
 *   - 按需编译 / 启动 / 看护 / 重启 helper；
 *   - 解析 JSON 行，只保留目标播放器会话；
 *   - 把 SMTC 的采样进度按 (now - lastUpdatedMs) 外推成连续进度；
 *   - 对「没有会话 / helper 挂了 / 编译失败」给出结构化状态，不抛异常。
 *
 * 为什么不直接在 Node 里调 WinRT：DSH 的 Electron Node 没有 CsWinRT 投影，
 * 也没有 koffi 之类的 FFI 依赖；独立 helper 是零依赖、可单测边界最清晰的做法。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, 'smtc-helper.cs');
const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
const WIN_METADATA = 'C:\\Windows\\System32\\WinMetadata';

/** 播放状态为空时的占位会话（宿主据此提示） */
const EMPTY = Object.freeze({ available: false, session: null, reason: 'starting', at: 0 });

/**
 * @typedef {Object} SmtcSession
 * @property {string} source
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {string} status
 * @property {boolean} playing
 * @property {number} positionMs
 * @property {number} durationMs
 * @property {number} lastUpdatedMs
 */

export class SmtcWatcher {
  /**
   * @param {{ intervalMs?: number, logger?: Pick<Console,'log'|'warn'|'error'> }} [options]
   */
  constructor(options = {}) {
    this.intervalMs = Math.max(200, Math.min(2000, Number(options.intervalMs) || 250));
    this.logger = options.logger ?? console;
    this.home = options.home || process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME || HERE;
    this.helperPath = options.helperPath || path.join(this.home, 'dsh-pet-qqmusic', 'bin', 'smtc-helper.exe');
    this.helperSource = options.helperSource || SOURCE;
    this.child = null;
    this.buffer = '';
    this.stopped = false;
    this.restartTimer = null;
    this.restartDelay = 500;
    this.last = { ...EMPTY };
    this.lastRaw = null;
    this.lastError = '';
    this.startedAt = 0;
    this.helperMissing = false;
    this._onData = this._onData.bind(this);
    this._onExit = this._onExit.bind(this);
  }

  start() {
    if (this.stopped || this.child) return;
    try {
      this._ensureHelper();
    } catch (e) {
      this.helperMissing = true;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.last = { available: false, session: null, reason: 'helper-missing', error: this.lastError, at: Date.now() };
      this.logger.error('[dsh-pet-qqmusic] SMTC helper 不可用：' + this.lastError);
      return;
    }
    this.startedAt = Date.now();
    try {
      const child = spawn(this.helperPath, ['--watch', `--interval=${this.intervalMs}`], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', this._onData);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.logger.warn('[dsh-pet-qqmusic] smtc-helper: ' + text);
      });
      child.on('error', (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.logger.error('[dsh-pet-qqmusic] smtc-helper 启动失败：' + this.lastError);
      });
      child.on('exit', this._onExit);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.logger.error('[dsh-pet-qqmusic] smtc-helper 启动异常：' + this.lastError);
      this._scheduleRestart();
    }
  }

  stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }

  /** 首次运行 / 源码更新时，用 Windows 自带 csc 编译到用户目录；随包不再放 exe */
  _ensureHelper() {
    const hasSource = existsSync(this.helperSource);
    const hasHelper = existsSync(this.helperPath);
    if (!hasSource && !hasHelper) throw new Error('缺少 lib/smtc-helper.cs');
    let rebuild = !hasHelper;
    if (hasSource && hasHelper) {
      try {
        rebuild = statSync(this.helperSource).mtimeMs > statSync(this.helperPath).mtimeMs;
      } catch {
        rebuild = true;
      }
    }
    if (!rebuild) {
      this.helperMissing = false;
      return;
    }
    const csc = CSC_CANDIDATES.find((p) => existsSync(p));
    if (!csc) throw new Error('找不到 .NET Framework csc.exe，无法编译 SMTC helper');
    mkdirSync(path.dirname(this.helperPath), { recursive: true });
    const tmp = this.helperPath + '.tmp.exe';
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    const fw = path.dirname(csc);
    const args = [
      '/nologo',
      '/target:exe',
      `/out:${tmp}`,
      `/r:${path.join(fw, 'System.Runtime.dll')}`,
      `/r:${path.join(fw, 'System.Runtime.WindowsRuntime.dll')}`,
      `/r:${path.join(WIN_METADATA, 'Windows.Foundation.winmd')}`,
      `/r:${path.join(WIN_METADATA, 'Windows.Media.winmd')}`,
      `/r:${path.join(WIN_METADATA, 'Windows.Storage.winmd')}`,
      this.helperSource,
    ];
    const result = spawnSync(csc, args, { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
    if (result.error) throw new Error('csc 启动失败：' + result.error.message);
    if (result.status !== 0 || !existsSync(tmp)) {
      const detail = String(result.stderr || result.stdout || '').trim().slice(0, 400);
      throw new Error(`csc 退出 ${result.status ?? 'null'}${detail ? '：' + detail : ''}`);
    }
    renameSync(tmp, this.helperPath);
    this.helperMissing = false;
    this.logger.log('[dsh-pet-qqmusic] 已编译 SMTC helper：' + this.helperPath);
  }

  /** 当前快照（已外推进度；永远返回对象，不抛） */
  getState() {
    const raw = this.last;
    if (!raw || !raw.available || !raw.session) return raw ?? { ...EMPTY };
    const s = raw.session;
    let positionMs = Number(s.positionMs) || 0;
    // SMTC 的 position 是采样值：LastUpdatedTime 之后音频继续走了多久就补多久。
    if (s.playing && s.lastUpdatedMs > 0) {
      const delta = Date.now() - s.lastUpdatedMs;
      // 只补合理区间（暂停/时钟漂移/休眠唤醒都可能给出巨大 delta）
      if (delta > 0 && delta < 3_600_000) positionMs += delta;
    }
    if (s.durationMs > 0) positionMs = Math.min(positionMs, s.durationMs);
    positionMs = Math.max(0, positionMs);
    return { ...raw, session: { ...s, positionMs } };
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._consume(msg);
    }
    // 防止 helper 异常刷屏导致缓冲无限增长
    if (this.buffer.length > 64 * 1024) this.buffer = '';
  }

  _consume(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.ok === false) {
      this.lastError = String(msg.error ?? 'unknown');
      this.last = { available: false, session: null, reason: 'helper-error', error: this.lastError, at: Date.now() };
      return;
    }
    const s = msg.session;
    if (!s || !s.title) {
      this.lastError = '';
      this.last = { available: false, session: null, reason: 'no-session', at: Date.now() };
      this.lastRaw = msg;
      return;
    }
    this.lastError = '';
    this.restartDelay = 500;
    this.last = {
      available: true,
      session: {
        source: String(s.source ?? ''),
        player: String(s.player || (/qqmusic/i.test(String(s.source ?? '')) ? 'qq' : 'netease')),
        title: String(s.title ?? ''),
        artist: String(s.artist ?? ''),
        album: String(s.album ?? ''),
        status: String(s.status ?? ''),
        playing: Boolean(s.playing),
        positionMs: Number(s.positionMs) || 0,
        durationMs: Number(s.durationMs) || 0,
        lastUpdatedMs: Number(s.lastUpdatedMs) || 0,
      },
      reason: 'ok',
      at: Date.now(),
    };
    this.lastRaw = msg;
  }

  _onExit(code, signal) {
    this.child = null;
    if (this.stopped) return;
    this.lastError = `smtc-helper 退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`;
    this.last = { available: false, session: null, reason: 'helper-exited', error: this.lastError, at: Date.now() };
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 10_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped) this.start();
    }, delay);
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }
}
