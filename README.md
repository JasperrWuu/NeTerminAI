# NeTerminAI

NeTerminAI 是一个面向开发、运维与网络设备管理的桌面终端工作台。它以稳定的终端连接为基础，用克制、清晰的工作台界面统一本地终端、远程会话和后续的 AI Agent 能力。

## 当前能力

- Tauri 2 + React + TypeScript 桌面工作台，Rust 负责系统与连接能力
- 可收起、可调整宽度的左右侧栏，以及清晰区分的中央终端区域
- 石墨深色主题与暖纸浅色主题，外观和终端设置会自动保存
- 英文字体与中文字体分开设置，字体候选自动读取 Windows 已安装字体；另有字号、字重、行距、光标、滚动缓冲与 ANSI 配色
- 独立设置页面与左侧设置导航；终端设置和快捷键设置互不受会话分区影响
- 可命名、折叠并单选启用的终端突显集；启用新集会自动关闭其它集，每套可包含多条文本或正则颜色规则
- PowerShell、命令提示符和 Git Bash 本地终端
- 标准 Telnet，支持地址、端口、账号、密码与终端尺寸同步
- 本机串口，提供可刷新、可键盘操作且支持手动输入的端口选择器，并支持波特率、数据位、停止位、奇偶校验和流控制
- 会话分区、保存、重命名与折叠；单击编辑，双击连接
- 多会话标签与独立终端状态，支持拖拽形成可递归嵌套的左右或上下分屏；分区边界可以直接拖动调整
- 可自定义工作台快捷键，支持可见字符终端同步输入、取消同步、会话顺序切换、`Ctrl + Equal` 将已打开会话按瓷砖重新排列与 `Ctrl+-` 合并分区
- 统一终端与设置页滚动条，并使用融合式自定义标题栏提供拖动、最小化、最大化/还原和关闭
- 统一的连接占位、取消和实例校验，避免关闭中的旧任务影响新会话

AI Agent、FTP/Syslog 等小工具仍处于后续规划阶段。

当前产品主线：Local Terminal → Telnet → Serial → Tile Layout / Pane → AI Assistant（规划中）。

## 技术架构

```text
apps/desktop/src           React 工作台、终端视图、连接表单与设置
apps/desktop/src-tauri     Rust 命令层、PTY、Telnet 与串口
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
- 旧版本保存的单层文字着色规则会自动迁移为“我的突显集”，无需手动重建。

构建目录中的 `neterminai_lib.dll.lib` 是 Windows MSVC 为 Tauri/Rust 动态库生成的导入库，属于正常的编译产物，不是额外安装的软件。
