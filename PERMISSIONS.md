# 权限、依赖与失败边界

DSH STORE 的固定源码扫描会标记本插件的文件 / 网络 / 命令能力。这是功能本身决定的，
不是隐藏行为；这里把边界写清楚，便于人工复核。

## 运行时依赖

- DSH（`^0.2.0-rc.1`）、Node.js 20+
- dsh-pet 的公开端点 `POST /dsh-pet-7340/broadcast`（不修改 dsh-pet 源码）
- Windows 10/11：QQ 音乐走 SMTC；网易云 3.0+ 走本地 `cloudmusic.elog`
- 首次运行 QQ 音乐支持时，用 Windows 自带的 `.NET Framework csc.exe` 编译
  `lib/smtc-helper.cs`；编译产物放在 `$DSH_HOME/dsh-pet-qqmusic/bin/`，不随包分发

## 文件

只读：

- `%USERPROFILE%\AppData\Local\NetEase\CloudMusic\cloudmusic.elog`
  （网易云播放状态；只解析歌名/歌手/专辑/songId/进度/播放状态，忽略 `musicurl`）
- 本地已有的歌词缓存（`$DSH_HOME/dsh-pet-qqmusic/cache/`）

写入：

- `$DSH_HOME/dsh-pet-qqmusic/cache/`：歌词缓存，30 天 TTL，按 LRU 清理
- `$DSH_HOME/dsh-pet-qqmusic/bin/`：编译出的 SMTC helper（仅首次/源码更新时）
- 配置路径 `$DSH_HOME/dsh-pet-qqmusic/config.json`（用户主动保存时）

不读取浏览器 Cookie、聊天记录、账号数据库或密钥文件。

## 网络

只访问公开曲库，不带账号 Cookie / API Key：

- `https://c.y.qq.com/`、`https://u.y.qq.com/`：QQ 音乐搜索 / 歌词
- `https://music.163.com/`：网易云搜索 / songId 歌词 / 曲目详情
- `https://lrclib.net/`：QQ/网易云都取不到时的可选兜底
- 本机 `http://127.0.0.1:<DSH_PORT>/dsh-pet-7340/broadcast`：前台被后台节流时，
  宿主直接写 dsh-pet 的歌词气泡（仅 loopback，不经过外部网络）

没有遥测、上报、Webhook 或动态服务器地址。

## 命令

- `tasklist`：只检测 `QQMusic.exe` / `cloudmusic.exe` 是否存在
- `csc.exe`：首次运行编译随包的 `lib/smtc-helper.cs`；参数固定，不拼接用户输入
- 编译出的 `smtc-helper.exe`：只读 Windows SMTC，不发网络请求
- `scripts/patch-dsh-pet-quiet-lyrics.mjs` 可选脚本：用 `powershell.exe` 重启
  dsh-pet 的 Electron helper；只在用户手动执行时运行

没有 `shell: true`，没有下载后执行，没有远程脚本。

## 凭据

- 不需要任何 API Key、OAuth、账号密码或 Cookie。
- 只读取非敏感路径环境变量：`DSH_HOME`、`USERPROFILE`、`HOME`。
- 不读取 `LOCALAPPDATA` 以外的凭据存储，不调用 Windows Credential Manager。

## 失败边界

- SMTC 会话不存在 / 未开启：状态为 `available:false`，提示开启 SMTC；
  不影响网易云 elog 路径。
- `csc.exe` 缺失或编译失败：QQ 音乐路径不可用并在 `/health` 报错；
  网易云路径仍然工作。
- 网易云日志不存在 / 版本过旧：提示 `elog-missing`，不伪造歌词。
- 搜索/歌词接口超时：当前曲目显示 `lyrics.status=error`，可手动“重新取词”；
  不缓存失败结果。
- 网络全部不可用：不崩、不阻塞 DSH；仅歌词不可用。

## 第三方

- `lib/netease-elog.js` 的 elog 解码表/状态机移植自
  `netease-cloudmusic-detector-py`（MIT），见 `THIRD_PARTY_NOTICES.md`。
- dsh-pet 的角色素材不随本包分发。
