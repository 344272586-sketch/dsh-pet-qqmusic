/**
 * dsh-pet-qqmusic —— 浏览器半侧（普通副作用脚本，不参与打包）。
 *
 * 为什么这里不是 React 组件：
 *   本插件不需要自己的 UI，只做一件事——轮询宿主状态，把「当前歌词行」投喂给 dsh-pet。
 *   dsh-pet 已经提供了第三方投喂端点 POST /dsh-pet-7340/broadcast（issue #76），
 *   写入它的 pets.<id>.say，桌宠气泡与桌面模式会在 1 秒内同步显示。
 *
 * 为什么由浏览器发而不是宿主发：
 *   dsh-pet 的路由在 DSH 浏览器信任栅栏后面，裸 HTTP 没有会话凭据会 401；
 *   浏览器同源 fetch 自带会话，和 dsh-pet 自己前端的调用方式一致。
 *
 * 延迟优化（v1.0.2）：
 *   - 轮询从 500ms 降到 300ms；
 *   - **主动排程下一行**：state 里带 nextLine.t 与 positionMs，客户端算好下一行还剩多少毫秒，
 *     用 setTimeout 在行开始前 120ms 投喂，不再干等下一次轮询；
 *   - 排程后用 pendingIndex 短暂压住「宿主还没切行」的旧行，避免气泡回跳；
 *   - 默认 offsetMs=600，用于补偿 dsh-pet 自身约 1 秒的状态轮询（可在配置里调）。
 */
(function () {
  var ID = 'dsh-pet-qqmusic';
  var ROUTE = '/dsh-pet-qqmusic';
  var PET_BROADCAST = '/dsh-pet-7340/broadcast';
  var POLL_MS = 300;
  var SCHEDULE_EARLY_MS = 120;
  var PENDING_HOLD_MS = 1200;

  function start() {
    var stopped = false;
    var timer = null;
    var nextTimer = null;
    var lastKey = '';
    var lastSentAt = 0;
    var lastHintAt = 0;
    var failures = 0;
    var warned = false;
    var lastTrackKey = '';
    var pendingIndex = -1;
    var pendingUntil = 0;
    var playingNow = false;
    var overlayEl = null;
    var hideTimer = null;
    var overlayCssInjected = false;

    function logWarn(msg) {
      if (!warned || failures % 60 === 0) {
        console.warn('[dsh-pet-qqmusic] ' + msg);
        warned = true;
      }
    }

    // 兜底过滤：宿主新版本已经会跳过开头制作名单；这里再拦一次，
    // 保证旧宿主缓存 / 极端 LRC 也不会让桌宠念「词：周杰伦」。
    var CREDIT_RE =
      /^\s*(作词|作曲|编曲|词|曲|制作人|制作|监制|出品人|出品|发行公司|发行|吉他|贝斯|鼓|键盘|弦乐|和声编写|和声|合声编写|合声|录音助理|录音工程|录音室|录音棚|录音|混音工程|混音室|混音|母带|人声|配唱|统筹|企划|制作统筹|音乐制作|封面|设计|版权|未经许可|特别鸣谢|鸣谢|OP|SP|A&R|Program|Producer|Composer|Lyricist|Arranger|Guitar|Bass|Drums|Piano|Strings|Backing Vocal|Recorded|Mixed|Mastered)\s*[：:]/i;

    function isCreditLine(text, track) {
      if (!text) return true;
      if (CREDIT_RE.test(text)) return true;
      // 「歌名 - 歌手 (英文名)」标题行
      if (!track || !track.title) return false;
      var t = text.toLowerCase();
      var title = String(track.title).toLowerCase();
      var artist = String(track.artist || '').toLowerCase();
      if (!t.includes(title)) return false;
      if (artist && !t.includes(artist)) return false;
      return t.includes(' - ') || t.includes('–') || t.includes('—') || t.indexOf(title) === 0;
    }

    function trackKeyOf(state) {
      var t = state && state.track;
      if (!t) return '';
      var player = state.player || '';
      // 网易云切歌早期可能只有 songId、没有标题；用 id 保证排程/待定行不会跨歌残留。
      if (t.songId) return player + '|id|' + t.songId;
      if (!t.title) return '';
      return player + '|' + t.title + '|' + (t.artist || '') + '|' + Math.round((t.durationMs || 0) / 3000);
    }

    function clearNext() {
      if (nextTimer) {
        clearTimeout(nextTimer);
        nextTimer = null;
      }
    }

    function lineText(line, cfg) {
      var prefix = typeof cfg.prefix === 'string' ? cfg.prefix : '♪ ';
      var text = prefix + line.text;
      if (cfg.showTranslation && line.trans) text += '\n' + line.trans;
      return text;
    }

    async function getState() {
      var res = await fetch(ROUTE + '/state.json', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error('state HTTP ' + res.status);
      return res.json();
    }

    async function broadcast(text, petId) {
      var url = PET_BROADCAST + (petId ? '?pet=' + encodeURIComponent(petId) : '');
      var res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text }),
      });
      if (!res.ok) throw new Error('broadcast HTTP ' + res.status);
      var json = await res.json().catch(function () {
        return null;
      });
      if (json && json.ok === false) throw new Error(json.message || json.reason || 'broadcast failed');
    }

    function bubbleFor(state) {
      var cfg = state.config || {};
      var prefix = typeof cfg.prefix === 'string' ? cfg.prefix : '♪ ';
      if (!state.enabled) return null;

      if (state.available && state.playing) {
        var line = state.line;
        if (line && line.text) {
          // 主动排程已把下一行投喂出去，宿主还没切行时不要回跳
          if (line.index < pendingIndex && Date.now() < pendingUntil) return null;
          if (isCreditLine(line.text, state.track)) return null;
          return {
            text: lineText(line, cfg),
            key: 'line:' + (state.track && state.track.title) + '#' + line.index + '#' + line.text,
            index: line.index,
          };
        }
        if (state.lyrics && state.lyrics.status === 'instrumental') {
          return { text: prefix + '纯音乐，请欣赏', key: 'instrumental:' + (state.track && state.track.title), index: null };
        }
        if (state.lyrics && state.lyrics.status === 'loading') return null;
        if (cfg.showTrackInfo && state.track && state.track.title) {
          return {
            text: prefix + state.track.title + (state.track.artist ? ' - ' + state.track.artist : ''),
            key: 'track:' + state.track.title,
            index: null,
          };
        }
      }

      // 没有会话：给出「没开 SMTC / 没开 QQ 音乐」的提示（节流 10 分钟）
      if (state.hint && state.hint.text && cfg.hints) {
        return { text: '♪ ' + state.hint.text, key: 'hint:' + state.hint.code, hint: true, index: null };
      }
      return null;
    }

    // ---- 自绘歌词气泡（默认模式）----
    // 直接复用 dsh-pet 的 .dsh-pet-bubble CSS，挂在它的 .dsh-pet-stage 里，
    // 只改文本节点、不写 dsh-pet 的 say 状态，所以宠物动画不会被逐行打断。
    function injectOverlayCss() {
      if (overlayCssInjected) return;
      overlayCssInjected = true;
      if (document.querySelector('style[data-plugin-css="dsh-pet-qqmusic/overlay"]')) return;
      var style = document.createElement('style');
      style.setAttribute('data-plugin-css', 'dsh-pet-qqmusic/overlay');
      style.textContent =
        '.dsh-pet-qqmusic-bubble{transition:opacity .18s ease;z-index:4}' +
        '.dsh-pet-qqmusic-bubble .dsh-pet-qqmusic-text{white-space:pre-wrap;word-break:break-word}' +
        '.dsh-pet-qqmusic-bubble[data-kind="hint"]{opacity:.96}';
      (document.head || document.documentElement).appendChild(style);
    }

    function findPetStage() {
      if (typeof document === 'undefined') return null;
      var roots = document.querySelectorAll('.dsh-pet-root');
      for (var i = 0; i < roots.length; i++) {
        var stage = roots[i].querySelector('.dsh-pet-stage');
        if (stage) return stage;
      }
      return null;
    }

    function ensureOverlay() {
      injectOverlayCss();
      var stage = findPetStage();
      if (!stage) return null;
      if (overlayEl && overlayEl.isConnected && overlayEl.parentElement === stage) return overlayEl;
      if (overlayEl && overlayEl.parentElement) overlayEl.remove();
      var el = document.createElement('div');
      el.className = 'dsh-pet-bubble dsh-pet-whisper dsh-pet-qqmusic-bubble';
      el.setAttribute('data-dsh-pet-qqmusic', '1');
      el.setAttribute('data-kind', 'line');
      var text = document.createElement('div');
      text.className = 'dsh-pet-qqmusic-text';
      el.appendChild(text);
      stage.appendChild(el);
      overlayEl = el;
      return el;
    }

    function showOverlay(text, kind) {
      var el = ensureOverlay();
      if (!el) return false;
      var node = el.querySelector('.dsh-pet-qqmusic-text');
      if (node && node.textContent !== text) node.textContent = text;
      el.setAttribute('data-kind', kind || 'line');
      el.classList.add('is-on');
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        if (overlayEl) overlayEl.classList.remove('is-on');
      }, 12000);
      return true;
    }

    function hideOverlay() {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (overlayEl) {
        overlayEl.remove();
        overlayEl = null;
      }
    }

    /** 按 displayMode 决定：自绘气泡（默认）还是 dsh-pet 投喂（会触发宠物说话动画） */
    async function deliver(item, cfg) {
      var mode = (cfg && cfg.displayMode) || 'auto';
      var wantOverlay = mode === 'overlay' || (mode === 'auto' && !!findPetStage());
      var shown = false;
      if (wantOverlay) shown = showOverlay(item.text, item.hint ? 'hint' : 'line');
      if (!shown && mode !== 'overlay') {
        // U+200B 是给 dsh-pet 桌面 helper 的「安静歌词」标记：
        // 打过补丁的 helper 会剥掉它、只更新气泡，不切宠物动画；未打补丁时它不可见，不影响显示。
        await broadcast('\u200B' + item.text, (cfg && cfg.petId) || '');
      }
    }

    async function sendItem(item, cfg) {
      await deliver(item, cfg);
      lastKey = item.key;
      lastSentAt = Date.now();
      if (typeof item.index === 'number') {
        pendingIndex = item.index;
        pendingUntil = Date.now() + PENDING_HOLD_MS;
      }
    }

    /**
     * 按 nextLine.t 主动排程下一行的投喂。
     * 宿主给的 positionMs 是「快照时刻」的值，这里补上请求往返/本地耗时才准。
     */
    function scheduleNext(state) {
      clearNext();
      if (!state || !state.available || !state.playing || !state.nextLine) return;
      var cfg = state.config || {};
      var offset = Number(state.offsetMs);
      if (!isFinite(offset)) offset = Number(cfg.offsetMs) || 0;
      var next = state.nextLine;
      if (typeof next.t !== 'number') return;
      if (isCreditLine(next.text, state.track)) return;
      var elapsed = Math.max(0, Date.now() - (state.at || Date.now()));
      var currentPos = (Number(state.positionMs) || 0) + elapsed;
      // 宿主选行条件是 position + offset >= line.t
      var msUntil = next.t - offset - currentPos;
      if (!isFinite(msUntil) || msUntil <= 0 || msUntil > 15000) return;
      var delay = Math.max(0, msUntil - SCHEDULE_EARLY_MS);
      var key = 'line:' + (state.track && state.track.title) + '#' + next.index + '#' + next.text;
      var text = lineText(next, cfg);
      nextTimer = setTimeout(function () {
        nextTimer = null;
        if (stopped || !playingNow) return;
        deliver({ text: text, key: key, index: next.index }, cfg)
          .then(function () {
            lastKey = key;
            lastSentAt = Date.now();
            pendingIndex = next.index;
            pendingUntil = Date.now() + PENDING_HOLD_MS;
            failures = 0;
          })
          .catch(function (e) {
            failures++;
            logWarn('排程投喂失败：' + (e && e.message ? e.message : String(e)));
          });
      }, delay);
    }

    async function tick() {
      if (stopped) return;
      try {
        var state = await getState();
        var cfg = state.config || {};
        playingNow = Boolean(state.available && state.playing);

        if (!state.enabled) {
          // 关掉插件时立刻收起自绘气泡，并清掉排程/待定行；
          // dsh-pet 自己的气泡会按它的计时器自然消失。
          playingNow = false;
          clearNext();
          hideOverlay();
          pendingIndex = -1;
          pendingUntil = 0;
          lastTrackKey = '';
          lastKey = '';
          lastSentAt = 0;
          return;
        }

        // 切歌：清掉排程与待定行
        var tk = trackKeyOf(state);
        if (tk !== lastTrackKey) {
          lastTrackKey = tk;
          pendingIndex = -1;
          pendingUntil = 0;
          clearNext();
        }

        var item = bubbleFor(state);
        if (item) {
          var now = Date.now();
          var keepAliveMs = Math.max(0, Number(cfg.keepAliveSec) || 0) * 1000;
          var same = item.key === lastKey;
          if (!(same && (!keepAliveMs || now - lastSentAt < keepAliveMs))) {
            if (!(item.hint && lastHintAt && now - lastHintAt < 10 * 60 * 1000)) {
              await sendItem(item, cfg);
              if (item.hint) lastHintAt = now;
            }
          }
        }

        scheduleNext(state);
        failures = 0;
      } catch (e) {
        failures++;
        logWarn('同步失败（第 ' + failures + ' 次）：' + (e && e.message ? e.message : String(e)));
      }
    }

    timer = setInterval(tick, POLL_MS);
    tick();
    return function () {
      stopped = true;
      clearNext();
      hideOverlay();
      if (timer) clearInterval(timer);
      timer = null;
    };
  }

  window.__ModuleLoader__.load({
    id: ID,
    factory: function () {
      var module = { exports: {} };
      var name = 'pet-qqmusic';
      // 只依赖核心 connection：保证页面连接服务就绪后再 apply；本插件不注册任何 UI。
      var inject = ['connection'];
      function apply(ctx) {
        var dispose = start();
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return dispose;
          }, 'dsh-pet-qqmusic: lyric bridge');
        }
      }
      module.exports = { name: name, inject: inject, apply: apply };
      return module.exports;
    },
  });
})();
