import * as vscode from "vscode";

export class ToolAuthorizationGate {
  private sessionAllowed = new Set<string>();

  async authorize(toolName: string, detail: string): Promise<boolean> {
    if (this.sessionAllowed.has(toolName)) {
      return true;
    }

    const pick = await vscode.window.showWarningMessage(
      `Tool permission required: ${toolName}\n${detail}`,
      { modal: true },
      "Allow Once",
      "Allow Session",
      "Deny"
    );

    if (pick === "Allow Session") {
      this.sessionAllowed.add(toolName);
      return true;
    }

    return pick === "Allow Once";
  }

  clearSession(): void {
    this.sessionAllowed.clear();
  }
}
