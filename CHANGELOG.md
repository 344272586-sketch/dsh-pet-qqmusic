# Changelog

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
