import * as vscode from "vscode";
import { SidekickConfig } from "../core/config";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRequest {
  permission: string;
  detail: string;
  pattern: string;
}

export interface SessionPermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

export class ToolAuthorizationGate {
  private sessionRules: SessionPermissionRule[] = [];

  async authorize(toolName: string, detail: string): Promise<boolean> {
    return this.authorizeRequests([
      {
        permission: toolName,
        detail,
        pattern: "*",
      },
    ]);
  }

  async authorizeRequests(requests: PermissionRequest[]): Promise<boolean> {
    for (const request of requests) {
      const rule = this.matchRule(request);
      if (rule?.action === "deny") {
        return false;
      }
      if (rule?.action === "allow") {
        continue;
      }

      const defaultAction = this.getDefaultAction(request.permission);
      if (defaultAction === "allow") {
        continue;
      }
      if (defaultAction === "deny") {
        return false;
      }

      const pick = await this.askPermission(request);
      if (pick === "Allow for Session") {
        this.sessionRules.push({
          permission: request.permission,
          pattern: request.pattern,
          action: "allow",
        });
        continue;
      }
      if (pick !== "Allow Once") {
        return false;
      }
    }

    return true;
  }

  clearSession(): void {
    this.sessionRules = [];
  }

  private matchRule(request: PermissionRequest): SessionPermissionRule | undefined {
    return this.sessionRules.find(
      (rule) =>
        rule.permission === request.permission &&
        this.matchesPattern(rule.pattern, request.pattern)
    );
  }

  private matchesPattern(rulePattern: string, requestPattern: string): boolean {
    if (rulePattern === "*") {
      return true;
    }
    if (rulePattern === requestPattern) {
      return true;
    }
    if (rulePattern.endsWith("*")) {
      return requestPattern.startsWith(rulePattern.slice(0, -1));
    }
    return false;
  }

  private async askPermission(
    request: PermissionRequest
  ): Promise<"Allow Once" | "Allow for Session" | "Deny" | undefined> {
    const copy = this.describePermission(request.permission);
    const options: Array<"Allow Once" | "Allow for Session" | "Deny"> = [
      "Allow Once",
      ...(this.supportsSessionAllow(request.permission)
        ? ["Allow for Session" as const]
        : []),
      "Deny",
    ];

    return vscode.window.showWarningMessage(
      [
        copy.title,
        copy.summary,
        request.detail,
        `Approval scope: ${request.pattern}`,
      ]
        .filter(Boolean)
        .join("\n"),
      { modal: true },
      ...options
    );
  }

  private describePermission(permission: string): {
    title: string;
    summary: string;
  } {
    switch (permission) {
      case "terminal_read":
        return {
          title: "Terminal permission required",
          summary: "This command will read project state.",
        };
      case "terminal_project_exec":
        return {
          title: "Terminal permission required",
          summary: "This command will run a project validation task.",
        };
      case "terminal_project_mutation":
        return {
          title: "Terminal permission required",
          summary: "This command will modify project state.",
        };
      case "terminal_external_access":
        return {
          title: "External file access required",
          summary: "This command will access files outside the current workspace.",
        };
      case "terminal_network":
        return {
          title: "Network access required",
          summary: "This command will access the network.",
        };
      case "terminal_destructive":
        return {
          title: "High-risk terminal command",
          summary:
            "This command may delete files, overwrite data, or run nested shell commands.",
        };
      default:
        return {
          title: "Tool permission required",
          summary: `This action requires permission for ${permission}.`,
        };
    }
  }

  private supportsSessionAllow(permission: string): boolean {
    return (
      permission !== "terminal_network" &&
      permission !== "terminal_destructive"
    );
  }

  private getDefaultAction(permission: string): PermissionAction {
    const policy = SidekickConfig.getPermissionPolicy();
    switch (permission) {
      case "terminal_read":
        return policy.terminal_read;
      case "terminal_project_exec":
        return policy.terminal_project_exec;
      case "terminal_project_mutation":
        return policy.terminal_project_mutation;
      case "terminal_external_access":
        return policy.terminal_external_access;
      case "terminal_network":
        return policy.terminal_network;
      case "terminal_destructive":
        return policy.terminal_destructive;
      default:
        return "ask";
    }
  }
}
