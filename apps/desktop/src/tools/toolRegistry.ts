import type { ComponentType } from "react";
import type { TerminalCapability } from "../capabilities/terminal";
import { AutomationIcon, ConfigurationIcon } from "../workbench/icons";
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
];
