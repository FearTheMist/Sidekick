import * as vscode from "vscode";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ContextSnapshot {
  currentFile: string;
  selectedCode: string;
  workspaceFiles: string[];
  git: string;
}

export async function collectContext(): Promise<ContextSnapshot> {
  const editor = vscode.window.activeTextEditor;

  const currentFile = editor
    ? truncate(editor.document.getText(), 10_000)
    : "";

  const selectedCode =
    editor && !editor.selection.isEmpty
      ? truncate(editor.document.getText(editor.selection), 4_000)
      : "";

  const workspaceFiles = await collectWorkspaceFiles();
  const git = await collectGitContext();

  return {
    currentFile,
    selectedCode,
    workspaceFiles,
    git,
  };
}

export function toContextPrompt(snapshot: ContextSnapshot): string {
  return [
    "<context>",
    "<current_file>",
    snapshot.currentFile,
    "</current_file>",
    "<selected_code>",
    snapshot.selectedCode,
    "</selected_code>",
    "<workspace_files>",
    snapshot.workspaceFiles.join("\n"),
    "</workspace_files>",
    "<git>",
    snapshot.git,
    "</git>",
    "</context>",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n...[truncated]`;
}

async function collectWorkspaceFiles(): Promise<string[]> {
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,.git,out,dist}/**",
    300
  );
  return files.map((uri) => vscode.workspace.asRelativePath(uri));
}

async function collectGitContext(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "No workspace folder";
  }

  try {
    const cwd = folder.uri.fsPath;
    const [branch, status, recent] = await Promise.all([
      execAsync("git branch --show-current", { cwd }),
      execAsync("git status --short", { cwd }),
      execAsync("git log -5 --pretty=format:%h%x20%s", { cwd }),
    ]);

    return [
      `branch: ${branch.stdout.trim()}`,
      "status:",
      truncate(status.stdout.trim(), 2_000),
      "recent_commits:",
      recent.stdout.trim(),
    ].join("\n");
  } catch (error) {
    return `Git unavailable: ${String(error)}`;
  }
}
