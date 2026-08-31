# NeTerminAI

NeTerminAI 是一个面向开发、运维与网络设备管理的桌面终端工作台。它以稳定的终端连接为基础，用克制、清晰的工作台界面统一本地终端、远程会话和后续的 AI Agent 能力。

## 当前能力

- Tauri 2 + React + TypeScript 桌面工作台，Rust 负责系统与连接能力
- 可收起、可调整宽度的左右侧栏，以及清晰区分的中央终端区域
- 石墨深色主题与暖纸浅色主题，外观和终端设置会自动保存
- 字体、字号、字重、行距、光标、滚动缓冲、ANSI 配色和文字匹配着色
- PowerShell、命令提示符和 Git Bash 本地终端
- 标准 Telnet，支持地址、端口、账号、密码与终端尺寸同步
- 本机串口，支持端口、波特率、数据位、停止位、奇偶校验和流控制
- SSH，使用系统 OpenSSH，在应用内完成主机校验和认证
- RDP，在工作区内宿主 Windows 官方远程桌面控件，不再启动外部 `mstsc.exe`
- 会话分区、保存、重命名与折叠；单击编辑，双击连接
- 多会话标签与独立终端状态，支持拖拽形成可递归嵌套的左右或上下分屏

AI Agent、FTP/Syslog 等小工具仍处于后续规划阶段。

## 技术架构

```text
apps/desktop/src           React 工作台、终端视图、连接表单与设置
apps/desktop/src-tauri     Rust 命令层、PTY、Telnet、串口、SSH 与 RDP
assets/brand               应用标志与品牌资源
docs                       产品、架构与设计约定
```

界面层只负责展示和交互；连接生命周期、系统进程与阻塞 I/O 留在 Rust 后端。各类会话共享统一的工作区标签模型，但保留独立的协议实现，避免把协议差异堆进同一段代码。

## 本地开发

准备以下环境：

- Node.js 与 npm
- Rust stable（Windows 使用 `x86_64-pc-windows-msvc`）
- Visual Studio Build Tools 的 MSVC 与 Windows SDK
- Microsoft Edge WebView2 Runtime
- 使用 SSH 时需要 Windows OpenSSH Client

安装依赖并启动桌面应用：

```powershell
npm install
npm run dev
```

首次启动需要编译 Rust 依赖，耗时会明显长于之后的启动。仅检查或构建前端：

```powershell
npm run typecheck
npm run build
```

构建 Windows 安装包：

```powershell
npm run tauri:build
```

## 数据与安全

- 设置、布局和保存的会话保存在本地应用数据中。
- Telnet 密码只有在用户明确选择后才会保存；Telnet 本身不是加密协议。
- SSH 密码、密钥口令和主机指纹交给系统 OpenSSH 处理，应用不保存 SSH 密码。
- RDP 密码与证书确认由 Windows 官方远程桌面控件处理，应用不读取或保存密码。

构建目录中的 `neterminai_lib.dll.lib` 是 Windows MSVC 为 Tauri/Rust 动态库生成的导入库，属于正常的编译产物，不是额外安装的软件。
