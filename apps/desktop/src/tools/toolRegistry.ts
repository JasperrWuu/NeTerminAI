import type { ComponentType } from "react";
import type { TerminalCapability } from "../capabilities/terminal";
import { AutomationIcon, ConfigurationIcon, DiagnosticTraceIcon, SubnetIcon, SyslogIcon, FtpIcon, RadiusIcon } from "../workbench/icons";
import { RadiusPanel } from "./RadiusPanel";
import { SyslogPanel } from "./SyslogPanel";
import { FtpPanel } from "./FtpPanel";
import { IpCalculatorPanel } from "./IpCalculatorPanel";
import { DiagnosticPanel } from "./DiagnosticPanel";
import { AutomationPanel } from "./AutomationPanel";
import { CfgPanel } from "./CfgPanel";

export interface ToolProps {
  activeTabId: string | null;
  terminal: TerminalCapability;
}

interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  icon: ComponentType;
  component: ComponentType<ToolProps>;
}

export const toolRegistry: readonly ToolDefinition[] = [
  {
    id: "cfg",
    name: "CFG · 设备启动配置",
    description: "快速生成基础管理配置",
    icon: ConfigurationIcon,
    component: CfgPanel,
  },
  {
    id: "automation",
    name: "终端自动化",
    description: "用 Python 脚本驱动已打开的终端",
    icon: AutomationIcon,
    component: AutomationPanel,
  },
  { id: "diagnostic", name: "诊断信息检查", description: "按命令检索、阅读与复制华为诊断 TXT", icon: DiagnosticTraceIcon, component: DiagnosticPanel },
  { id: "ip-calculator", name: "IP 地址计算器", description: "IPv4 / IPv6 子网与整数转换", icon: SubnetIcon, component: IpCalculatorPanel },
  { id: "syslog", name: "SYSLOG 服务器", description: "接收本地网卡上的设备 UDP 日志", icon: SyslogIcon, component: SyslogPanel },
  { id: "ftp", name: "FTP 服务器", description: "主动模式文件上传与下载", icon: FtpIcon, component: FtpPanel },
  { id: "radius", name: "RADIUS 服务器", description: "PAP / CHAP 与挑战认证联调", icon: RadiusIcon, component: RadiusPanel },
];
