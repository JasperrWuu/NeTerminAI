import type { ComponentType } from "react";
import type { TerminalCapability } from "../capabilities/terminal";
import { ConfigurationIcon } from "../workbench/icons";
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
];
