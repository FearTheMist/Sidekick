import * as vscode from "vscode";

const MAX_CONTEXT_CHARS = 12000;

export type EditorSelectionContext = {
  filePath: string;
  startLine: number;
  endLine: number;
  selectedText: string;
};

export function getCurrentEditorSelectionContext(): EditorSelectionContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    return undefined;
  }

  const raw = editor.document.getText(selection).trim();
  if (!raw) {
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const filePath = workspaceFolder
    ? vscode.workspace.asRelativePath(editor.document.uri, false)
    : editor.document.uri.fsPath;

  const truncated = raw.length > MAX_CONTEXT_CHARS ? `${raw.slice(0, MAX_CONTEXT_CHARS)}\n...` : raw;

  return {
    filePath,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
    selectedText: truncated
  };
}

export function buildSelectionContextPrompt(context: EditorSelectionContext): string {
  return [
    "Use the following selected code as context for this reply:",
    `File: ${context.filePath}`,
    `Lines: ${context.startLine}-${context.endLine}`,
    "```",
    context.selectedText,
    "```"
  ].join("\n");
}

export function toSelectionHint(context: EditorSelectionContext | undefined):
  | {
      filePath: string;
      startLine: number;
      endLine: number;
    }
  | undefined {
  if (!context) {
    return undefined;
  }

  return {
    filePath: context.filePath,
    startLine: context.startLine,
    endLine: context.endLine
  };
}
