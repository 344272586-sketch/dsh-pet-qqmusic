# Security

## 不会收集什么

- 不需要 DeepSeek / OpenAI / QQ 音乐的任何 API Key。
- 不读取 QQ 音乐或浏览器的 Cookie、账号密码、登录凭据。
- 不上传听歌记录、账号信息或本机文件。

插件只做两件事：

1. 通过 Windows SMTC 读取本机当前媒体会话的**公开元数据**（歌名 / 歌手 / 专辑 / 播放进度）；
2. 用歌名 + 歌手去 QQ 音乐公开曲库搜索并拉取 LRC 歌词（失败时可选回落 lrclib）。

## 二进制文件

`lib/smtc-helper.exe` 是 `lib/smtc-helper.cs` 用 Windows 自带 `csc` 编译的 x64 helper，
只调用 `Windows.Media.Control` 读取媒体会话，不发任何网络请求。源码在同一目录，可自行重建。

## 桌面 quiet 补丁

`scripts/patch-dsh-pet-quiet-lyrics.mjs` 会修改 dsh-pet 的运行时文件
`runtime/electron-helper/events.js`，在原文件旁生成 `.bak-qqmusic` 备份，
只插入一个「带 `U+200B` 标记的投喂只更新气泡」的分支。它不读取、不写入任何密钥。

## 报告问题

如果发现安全问题，请开一个 GitHub Security Advisory，或直接开 issue（不要贴任何 token / 账号信息）。
