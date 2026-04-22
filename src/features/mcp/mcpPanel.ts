import * as vscode from "vscode";
import { McpManager } from "../../mcp/mcpManager";
import { openControlCenterPanel } from "../controlCenter/controlCenterPanel";

export async function openMcpPanel(
  _extensionUri: vscode.Uri,
  manager: McpManager,
  clearSessionPermissions: () => void
): Promise<void> {
  await openControlCenterPanel("mcp", manager, clearSessionPermissions);
}
