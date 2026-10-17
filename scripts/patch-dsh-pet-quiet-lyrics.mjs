#!/usr/bin/env node
/**
 * dsh-pet 桌面 helper 的「安静歌词」补丁。
 *
 * 背景：
 *   dsh-pet 的 /broadcast 在桌面 helper 里走 PetSprite.showWhisper()——每次投喂都会
 *   随机挑一个「碎碎念」动画并 playOnce，所以歌词每换一行宠物模型就换一次动作/重播。
 *   web 模式可以用本插件自绘气泡绕开；但 display=desktop 的悬浮小窗没有 DOM 可叠，
 *   只能给 helper 加一个分支：带 U+200B 前缀的投喂只更新气泡，不切动画、不 playOnce。
 *
 * 这是对 dsh-pet **运行时文件**的补丁，不修改它的源码包：
 *   - 幂等：已打补丁会直接跳过；
 *   - 只认精确的函数签名，dsh-pet 改版后签名不同就报错退出，不会乱写；
 *   - dsh-pet 升级会覆盖该文件，升级后重跑本脚本即可。
 *
 * 用法：
 *   node scripts/patch-dsh-pet-quiet-lyrics.mjs            # 只打补丁
 *   node scripts/patch-dsh-pet-quiet-lyrics.mjs --restart  # 打补丁并重启桌面 helper
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SIGNATURE = 'PetSprite.prototype.showWhisper = function showWhisper(text, image) {';
const MARKER = '// dsh-pet-qqmusic: quiet lyric branch';
const BRANCH = `
  ${MARKER}
  // 以 U+200B 开头的投喂只更新气泡，不切动画/不重播（歌词逐行同步不打断宠物）
  if (typeof text === 'string' && text.charCodeAt(0) === 0x200b) {
    text = text.slice(1);
    if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
    this.whisperOn = true;
    this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
    this.whisperImage = typeof image === 'string' ? image : '';
    this.renderBubble();
    this.whisperTimer = window.setTimeout(() => {
      this.whisperOn = false;
      this.renderBubble();
    }, BUBBLE_DURATION_MS);
    return;
  }`;

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDirs = [
  process.env.DSH_PROFILE_DIR,
  path.join(home, 'profiles', 'desktop'),
  path.join(home, 'profiles', 'web'),
].filter(Boolean);

function findEventsFile() {
  for (const dir of profileDirs) {
    const p = path.join(dir, 'node_modules', 'dsh-pet', 'runtime', 'electron-helper', 'events.js');
    if (existsSync(p)) return p;
  }
  return null;
}

function restartHelper() {
  const cmd =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dsh-pet*electron-helper*main.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 0";
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
    console.log('已请求重启 dsh-pet 桌面 helper（宿主会自动拉起新进程）。');
  } catch (e) {
    console.warn('重启 helper 失败，请右键桌宠 →「重载配置」或重启 DSH：' + (e instanceof Error ? e.message : String(e)));
  }
}

const file = findEventsFile();
if (!file) {
  console.error('找不到 dsh-pet 的 runtime/electron-helper/events.js，请确认 dsh-pet 已安装。');
  process.exit(1);
}

let src = readFileSync(file, 'utf8');
if (src.includes(MARKER)) {
  console.log('已打过补丁，跳过：' + file);
  if (process.argv.includes('--restart')) restartHelper();
  process.exit(0);
}
const idx = src.indexOf(SIGNATURE);
if (idx < 0) {
  console.error('events.js 里找不到 showWhisper 函数签名，dsh-pet 可能已改版；为避免写坏文件，已退出。');
  console.error('文件：' + file);
  process.exit(2);
}

const backup = file + '.bak-qqmusic';
if (!existsSync(backup)) writeFileSync(backup, src, 'utf8');
const at = idx + SIGNATURE.length;
src = src.slice(0, at) + BRANCH + src.slice(at);
const tmp = file + '.tmp';
writeFileSync(tmp, src, 'utf8');
renameSync(tmp, file);
console.log('补丁已写入：' + file);
console.log('备份：' + backup);
if (process.argv.includes('--restart')) restartHelper();
