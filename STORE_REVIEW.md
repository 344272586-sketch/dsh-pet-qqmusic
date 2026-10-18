# DSH STORE 复核材料

运行时固定源码 Commit（1.3.3）：

```text
93c509b1c6db7bfa54f26a1d62414d1fe264f48a
```

版本：`1.3.4`（1.3.4 只增加本文件、文档和测试，运行时行为与 1.3.3 相同）  
仓库：`https://github.com/344272586-sketch/dsh-pet-qqmusic`

## 状态

- **已验证**：QQ 音乐 SMTC / 网易云 elog 双路径、按 `player` 选择、seek 处理、35 项单测、Linux CI Node 20/22、运行时编译 helper；`build-dsh-plugin` 只读审计 80/100，无 blocker，状态 `isolated-acceptance-ready`。
- **部分验证**：Windows 实机只覆盖当前机器（Windows 11、QQ 音乐 22.76、网易云 3.1.39）；其他 Windows 版本与播放器小版本未逐一验收。
- **部分验证**：Windows 实机只覆盖当前机器（Windows 11、QQ 音乐 22.76、网易云 3.1.39）；其他 Windows 版本与播放器小版本未逐一验收。
- **未验证**：DSH STORE 人工专项审阅、一次性 Profile 的安装/启动/卸载/回滚矩阵；本项目没有执行第三方 install/build/test。
- **受阻**：DSH STORE 自动策略不接受 `files` / `network` / `commands` 任一信号；这是功能必需能力，不是扫描遗漏。

## 固定源码扫描复现

按 DSH STORE `bounded-source-v3` 在本地复跑（不安装、不执行插件）：

```text
scanComplete                true
unsupportedFiles            0
filesScanned / runtimeFiles 9 / 9
credentials                 false
nativeOrExecutableArtifacts false
protectedDsh                false
files / network / commands  true
securityVerdict             warn (child-process x3)
```

因此自动策略的“不可扫描 / 预编译产物”阻塞已经消失；剩余原因只有：

```text
runtime source contains the files permission signal
runtime source contains the network permission signal
runtime source contains the commands permission signal
fixed-source security warnings require review
```

## 权限矩阵

| 能力 | 声明 | 证据 |
|---|---|---|
| files | write | 读 `%USERPROFILE%\AppData\Local\NetEase\CloudMusic\cloudmusic.elog`；写 `$DSH_HOME/dsh-pet-qqmusic/cache` 与 `bin` |
| network | specified-services | `c.y.qq.com`、`u.y.qq.com`、`music.163.com`、`lrclib.net` |
| commands | restricted | `tasklist`、`csc.exe`、编译出的 `smtc-helper.exe`、可选补丁脚本的 `powershell.exe` |
| credentials | none | 不读 Cookie / API Key / OAuth / Credential Manager |
| native artifacts | none in package | 首次运行从 `lib/smtc-helper.cs` 编译到 `$DSH_HOME` |

## 边界与失败处理

- 没有 SMTC 会话：`available:false` + SMTC 提示；网易云 elog 路径不受影响。
- `csc.exe` 缺失/编译失败：QQ 路径报错，网易云仍工作。
- 网易云日志缺失：`elog-missing`，不伪造歌词。
- 歌词接口失败：`lyrics.status=error`，不缓存失败结果，可手动重新取词。
- 网络全断：不崩、不阻塞 DSH，仅歌词不可用。

## 下一步 / Next gate

1. 等 DSH STORE 每 8 小时的自动复检读取 `93c509b`。
2. 复检若仍 blocked，应只剩 `files/network/commands` 权限原因；需要商城按“完整固定源码专项审阅”给出 `user-reviewed`。
3. 如进入人工审阅，建议在一次性 Profile 验收：安装、启动、QQ/网易云各放一首、卸载；本仓库不声称已完成该矩阵。
4. 自动策略不会因为作者声明而批准高权限插件；本文件只提供审阅证据，不构成自我批准。

## 相关文件

- `PERMISSIONS.md`：完整权限与外部服务说明
- `SECURITY.md`：安全边界
- `lib/smtc.js`：运行时编译与进程看护
- `lib/netease-elog.js`：网易云日志解码
- `test/*.test.mjs`：35 项单测
