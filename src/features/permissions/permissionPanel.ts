import { McpManager } from "../../mcp/mcpManager";
import { openControlCenterPanel } from "../controlCenter/controlCenterPanel";

export async function openPermissionPanel(
  manager: McpManager,
  clearSessionPermissions: () => void
): Promise<void> {
  await openControlCenterPanel("permissions", manager, clearSessionPermissions);
}
