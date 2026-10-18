# Security

## 不会收集什么

- 不需要 DeepSeek / OpenAI / QQ 音乐 / 网易云音乐的任何 API Key。
- 不读取 QQ 音乐、网易云音乐或浏览器的 Cookie、账号密码、登录凭据。
- 不上传听歌记录、账号信息或本机文件。

插件只做两件事：

1. 读取本机播放器的**公开播放状态**：
   - QQ 音乐：Windows SMTC（歌名 / 歌手 / 专辑 / 进度 / 状态）；
   - 网易云音乐：本地 `%LOCALAPPDATA%\NetEase\CloudMusic\cloudmusic.elog` 中的歌名 / 歌手 / 专辑 / songId / 进度 / 状态；
2. 用歌名 + 歌手或 songId 去公开曲库（QQ 音乐 / 网易云音乐）拉取 LRC 歌词，失败时可选回落 lrclib。

## 网易云日志

`cloudmusic.elog` 里包含 `musicurl` 等带签名的播放地址。`lib/netease-elog.js` **只解析**
`checkPlayPrivilege` / `playOneTrackInPlayingList` / `native播放state` / `setPlayingPosition` /
`native播放资源load完成` 这几类事件，并把结果限制在歌名、歌手、专辑、时长、songId、进度和播放状态。
`musicurl` 不会进入状态、不会落盘、不会上传。

## 二进制文件

`lib/smtc-helper.exe` 是 `lib/smtc-helper.cs` 用 Windows 自带 `csc` 编译的 x64 helper，
只调用 `Windows.Media.Control` 读取媒体会话，不发任何网络请求。源码在同一目录，可自行重建。

## 桌面 quiet 补丁

`scripts/patch-dsh-pet-quiet-lyrics.mjs` 会修改 dsh-pet 的运行时文件
`runtime/electron-helper/events.js`，在原文件旁生成 `.bak-qqmusic` 备份，
只插入一个「带 `U+200B` 标记的投喂只更新气泡」的分支。它不读取、不写入任何密钥。

## 报告问题

如果发现安全问题，请开一个 GitHub Security Advisory，或直接开 issue（不要贴任何 token / 账号信息）。
