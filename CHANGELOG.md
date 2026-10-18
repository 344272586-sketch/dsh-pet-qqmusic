# Changelog

## 1.3.7

- 歌词缓存 schema 升到 v2：解析/制作名单/翻译规则变化时旧缓存自动失效并被删除
- 每写 50 次缓存清理超过 400 个文件，长时间不重启也不会无限膨胀
- 客户端 state/broadcast 加 5s / 8s 超时与 in-flight 防重入，宿主卡住时不会无限挂起或堆叠 tick
- 客户端 offset 读取改为严格 number 判断，兼容没有 `state.offsetMs` 的旧宿主
- 客户端切歌时清空 `lastKey/lastSentAt`，新歌第一句文本碰巧相同时也会重新投喂
- 网易云日志 carry 也受 `MAX_CARRY_BYTES` 限制，异常超长半行不会无限增长
- QQ/网易云同时开着且都没有可读会话时，提示改为合并原因，不再只说“网易云没在播放”
- 按 songId 取词时，曲目详情接口失败不再阻断歌词接口
- SMTC helper 的 spawn `error` 会释放 child 并安排重试；退出/重启时清空行缓冲
- SMTC helper 源码更新后重新编译失败时，回退使用已有的旧 helper，不直接丢掉 QQ 路径
- 网易云恢复会话后重置 `neteaseReason`，`/health` 不再显示旧的 `elog-missing`
- 新增缓存 schema / 详情失败回退单测，共 39 项

## 1.3.6

- 新增 `neteaseOffsetMs`：网易云可以单独设提前量，`null` 时跟随 `offsetMs`；客户端排程使用当前播放器的有效 offset
- 新增 Windows CI job：跑单测、用系统 `csc.exe` 编译 SMTC helper，并执行 `--any` 探针验证 JSON
- 单测补到 37 项

## 1.3.5

- 客户端切歌 key 纳入 `player` / `songId`，网易云只有 id 时不会把上一首的排程/待定行带到下一首
- 客户端制作名单过滤允许 `作词 :` 这类冒号前空格，旧缓存也不会念制作名单
- 关闭插件时立即收起自绘气泡、清掉排程；重新开启立即恢复
- `/config.json` 的写入必须带 `application/json`，降低本地 CSRF 面
- 新增 `neteasePath` 配置，支持非默认的 `cloudmusic.elog` 路径
- 新增配置路由测试（36 项）

## 1.3.4

- 新增 `STORE_REVIEW.md`：固定源码、权限矩阵、扫描复现、已验证/未验证/受阻状态与下一步
- 新增 watcher 抛异常时的 fail-closed 单测（35 项）
- 重命名 `test/client.test.mjs` 为 `test/ui-delivery.test.mjs`，避免
  `build-dsh-plugin` 把它误判成 Browser Client Host import
- 运行时行为与 1.3.3 相同

## 1.3.3

- 不再随包分发 `lib/smtc-helper.exe`：首次启动用 Windows 自带 `csc.exe` 从
  `lib/smtc-helper.cs` 编译到 `$DSH_HOME/dsh-pet-qqmusic/bin/`，修复 DSH STORE
  “unsupported artifacts / fixed-source scan incomplete”
- 去掉 `process.env.LOCALAPPDATA` / `DSH_PROFILE_DIR` 读取，固定源码扫描不再命中
  credentials 信号；补丁脚本改收 `--profile-dir=`
- 新增 `PERMISSIONS.md`：文件 / 网络 / 命令 / 凭据 / 外部服务 / 失败边界
- 说明：文件、网络、命令能力是功能本身；DSH STORE 仍可能需要人工复核，
  不会被声明自动批准

## 1.3.2

- 修复 QQ 音乐和网易云同时开着时，网易云的 SMTC 会话（常常没有进度）抢走 QQ 会话，导致 QQ 歌词不显示
- SMTC helper 改为给会话打分：正在播放 > 有时间轴 > 最近更新 > 系统当前会话 > QQ 兜底
- 服务端按会话自己的 `player` 过滤，`player: qq` / `player: netease` 不会再被另一个播放器的 SMTC 会话顶替
- 网易云 elog 与 SMTC 同时可用时优先 elog；elog 不可用时 `player: netease` 可回退到网易云 SMTC
- 新增 4 项双会话 / 强制播放器单测（共 34 项）

## 1.3.1

- 网易云：日志改为按字节缓冲，修复读边界劈开 UTF-8 汉字或半行时歌词乱码 / 丢行
- 网易云：识别 crash server 的 `Process <pid> exited`（含没有墙钟时间的行），客户端退出后立即清空会话，不再残留最后一句歌词
- 网易云：启动预载时正确重建「播放中 → 暂停 → seek」后的进度
- 网易云：歌词按 songId 缓存，重复播放直接命中；补标题时复用取词结果，少发一次曲目详情请求
- 进度 / 当前行改为在 `state.json` 请求时外推，修掉最多 200ms 的滞后；新增 `positionAt`
- 「重新取词」现在真正绕过磁盘缓存，并且不会在下一轮重复请求
- 测试补充到 30 个

## 1.3.0

- 新增网易云音乐支持：直接读 `cloudmusic.elog`，不需要 BetterNCM / InfLink，支持播放/暂停与 seek
- 新增 `player` 配置（`auto` / `qq` / `netease`），自动选择正在播放的播放器
- 网易云优先用 songId 取词（本地缓存 / 公开 API），避免同名版本错配
- SMTC helper 可识别 `cloudmusic` / `netease` 会话（InfLink 等方案的回退路径）
- 新增 `lib/netease-elog.js`、`THIRD_PARTY_NOTICES.md` 与对应单测

## 1.2.0

- 歌词更新不再切宠物动画：web 模式使用自绘歌词气泡；桌面悬浮模式提供 `scripts/patch-dsh-pet-quiet-lyrics.mjs`
- 桌面 helper 补丁支持 `U+200B` 安静歌词标记：只更新气泡，不 `playOnce`、不打断移动
- 新增 `displayMode`（`auto` / `overlay` / `bubble`）

## 1.1.0

- 延迟优化：客户端 300ms 轮询 + 按 `nextLine.t` 主动排程
- 默认 `offsetMs` 调整为 600ms，补偿 dsh-pet 气泡约 1 秒的轮询
- 自动跳过开头的词曲 / 编曲 / 吉他等制作名单

## 1.0.0

- 首个版本：SMTC 读取 QQ 音乐播放进度、QQ 音乐曲库匹配 LRC、桌宠气泡逐行同步
- 翻译合并、纯音乐识别、歌词磁盘缓存
- 修复 QQ 音乐 `PlaybackRate` 为空导致 helper 输出非法 JSON 的问题
