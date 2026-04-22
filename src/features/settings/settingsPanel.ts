import { McpManager } from "../../mcp/mcpManager";
import { openControlCenterPanel } from "../controlCenter/controlCenterPanel";

export async function openSettingsPanel(
  manager: McpManager,
  clearSessionPermissions: () => void
): Promise<void> {
  await openControlCenterPanel("providers", manager, clearSessionPermissions);
}
