# 架构概览

NeTerminAI 采用 Tauri 模块化单体架构。

```text
React UI → Tauri Commands / Events → Rust Application Core → PTY / Telnet / SSH / Storage
```

## 约束

- React 负责界面和交互呈现，不管理系统进程。
- Rust 是会话状态的唯一可信来源。
- 高频终端输出不进入 React 全局状态。
- Tauri 命令保持轻薄，只负责校验、调用和结果转换。
- AI 未来只能提交结构化动作，不能绕过策略层直接写入 PTY。

## 本地终端链路

```text
xterm.js → Tauri command → TerminalManager → portable-pty → PowerShell
PowerShell → PTY reader thread → Tauri event → xterm.js
```

PTY 输出以 Base64 编码的原始字节块传输。界面层使用流式 UTF-8 解码器保留跨数据块字符边界，在可选的文字着色规则处理后交给 xterm.js 完成终端字符解析和绘制。

## Telnet 链路

TelnetManager 将连接建立、读取、顺序写入和关闭分离。协议状态机负责 IAC 协商并抑制重复响应；终端输出按显示帧合并后交给 xterm.js，避免高吞吐连接用大量小事件阻塞界面。正在建立的连接可被标签关闭动作立即取消。

保存会话与运行中连接相互独立。会话库保存连接资料、登录模式和用户分区；工作区标签持有一次连接所需的快照，不依赖侧栏项目继续存在。

## 工作区标签

标签资源使用通用 `WorkspaceTab` 联合类型，不绑定到 PowerShell 或字符终端。工作区布局是由 `pane` 和 `split` 组成的递归树：叶子分区维护自己的标签顺序和活动标签，分支节点只描述左右或上下等分。拖动标签时先从来源叶子分离，再移动到目标叶子或把目标叶子替换为新的分支，因此任意分区都能继续嵌套拆分。

本地终端、Telnet、串口、SSH、RDP 与设置视图共用这一布局模型。协议生命周期仍然互相独立，分屏只改变视图归属，不重建正在运行的会话。

## 设置与布局

- `ApplicationSettings` 保存主题、终端字体、光标、缓冲、ANSI 配色和文字着色规则。这些是用户设置，未来可导入、导出或同步。
- `WorkbenchPreferences` 保存侧栏开关和宽度。这些是当前设备、当前窗口的布局偏好。
- 终端外观变更直接更新 xterm.js 渲染选项，不销毁或重建底层 PTY 会话。

## 演进原则

优先完成真实功能，再根据重复、耦合和性能证据提取抽象。不为尚未出现的协议或极端情况预先建立复杂框架。
