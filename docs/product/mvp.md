# Terminal Workbench MVP

## 目标

交付一款在没有 AI 的情况下也可靠、顺畅、愿意日常使用的 Windows 终端工作台。

## 当前增量

应用外壳、本地 PowerShell/CMD 与 Telnet 已经建立。Telnet 支持稳定的协议协商、标准账号密码登录、仅密码串口服务器登录，以及分区化的保存会话。

## 后续顺序

1. 继续验证 Telnet 设备兼容性
2. SSH
3. 串口直连
4. AI 上下文与命令建议

## 非目标

当前不实现串口直连、RDP、工具服务器、插件市场和自动执行 Agent。
