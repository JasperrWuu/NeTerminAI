# NeTerminAI

NeTerminAI 是一个面向开发与运维场景的桌面终端工作台。项目将以可靠的终端体验为基础，逐步加入远程连接、实用工具与用户自定义 AI Agent。

## 当前阶段

当前已完成应用外壳和第一个真实终端链路：

- Tauri 2 + React + TypeScript 基础工程
- 可收起、可调整宽度的左右侧栏
- 中央工作区、活动栏与状态栏
- 明亮/暗色主题和布局持久化
- 正式的应用设置模型与独立设置标签
- 终端字体、字号、字重、行距和滚动缓冲自定义
- 光标形状、闪烁与 ANSI 配色自定义
- 可扩展的设计 Token
- xterm.js 终端渲染
- Rust PTY 会话管理
- 本地 PowerShell 输入输出与尺寸同步
- 通用工作区标签模型
- 多个独立本地终端标签
- PowerShell 与 CMD 本地终端配置
- Telnet 远程终端、协议协商与终端尺寸同步
- Telnet IP、端口、账号和密码连接配置
- 可保存的 Telnet 会话（密码由用户明确选择是否保存）
- 标准 Telnet 与仅密码串口服务器登录模式
- 可创建、重命名和折叠的会话分区
- 保存会话单击编辑、双击直接连接

SSH、串口和 AI 会在后续增量中接入。

## 开发

```powershell
npm install
npm run dev
```

只构建前端：

```powershell
npm run build
```
