# Terminal Workbench MVP

## 目标

交付一款在没有 AI 的情况下也可靠、顺畅、愿意日常使用的 Windows 终端工作台。

## 当前增量

应用外壳、本地 PowerShell/CMD/Git Bash、Telnet 与串口已经建立。会话支持分区化保存，工作区标签支持递归的左右/上下分屏，并可用 `Ctrl + Equal` 将已打开会话按瓷砖重新排列；终端外观、可切换突显集与工作台快捷键可以由用户自定义；可见字符终端支持同步输入。

第一阶段产品主线为：Local Terminal、Telnet、Serial 与 Tile Layout / Pane；AI Assistant 作为后续增量规划。

## 后续顺序

1. 完善可保存的工作区布局体验
2. AI 上下文与命令建议
3. FTP、Syslog 与文本工具

## 非目标

当前不实现工具服务器、插件市场和自动执行 Agent。
