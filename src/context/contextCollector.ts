import * as vscode from "vscode";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const MAX_SELECTED_CODE = 4_000;
const MAX_SEARCH_RESULTS = 6;
const MAX_SEARCH_FILES = 200;
const SEARCH_EXCLUDE = "**/{node_modules,.git,out,dist}/**";

export interface ContextSnapshot {
  selectedLocation: string;
  selectedCode: string;
  searchResults: string[];
  git: string;
}

export async function collectContext(userPrompt: string): Promise<ContextSnapshot> {
  const editor = vscode.window.activeTextEditor;
  const selectedLocation = getSelectedLocation(editor);
  const selectedCode =
    editor && !editor.selection.isEmpty
      ? truncate(editor.document.getText(editor.selection), MAX_SELECTED_CODE)
      : "";

  const searchResults = selectedCode ? [] : await collectSearchResults(userPrompt);
  const git = await collectGitContext();

  return {
    selectedLocation,
    selectedCode,
    searchResults,
    git,
  };
}

export function toContextPrompt(snapshot: ContextSnapshot): string {
  return [
    "<context>",
    "<selected_location>",
    snapshot.selectedLocation,
    "</selected_location>",
    "<selected_code>",
    snapshot.selectedCode,
    "</selected_code>",
    "<search_results>",
    snapshot.searchResults.join("\n\n"),
    "</search_results>",
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

export function getSelectedLocation(
  editor: vscode.TextEditor | undefined
): string {
  if (!editor || editor.selection.isEmpty) {
    return "";
  }

  const path = vscode.workspace.asRelativePath(editor.document.uri);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  return start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
}

async function collectSearchResults(userPrompt: string): Promise<string[]> {
  const queries = extractSearchQueries(userPrompt);
  if (queries.length === 0) {
    return [];
  }

  const files = await vscode.workspace.findFiles("**/*", SEARCH_EXCLUDE, MAX_SEARCH_FILES);
  const results: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }

    const text = await readWorkspaceText(file);
    if (!text) {
      continue;
    }

    const lower = text.toLowerCase();
    for (const query of queries) {
      const index = lower.indexOf(query.toLowerCase());
      if (index === -1) {
        continue;
      }

      const snippet = buildSnippet(text, index, query.length);
      const entry = `${vscode.workspace.asRelativePath(file)}: ${snippet}`;
      if (seen.has(entry)) {
        continue;
      }

      seen.add(entry);
      results.push(entry);
      break;
    }
  }

  return results;
}

async function readWorkspaceText(uri: vscode.Uri): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.length === 0) {
      return "";
    }

    const text = Buffer.from(bytes).toString("utf8");
    if (text.includes("\u0000")) {
      return "";
    }
    return text;
  } catch {
    return "";
  }
}

function buildSnippet(text: string, start: number, length: number): string {
  const from = Math.max(0, start - 120);
  const to = Math.min(text.length, start + length + 120);
  const prefix = from > 0 ? "..." : "";
  const suffix = to < text.length ? "..." : "";
  return `${prefix}${truncate(text.slice(from, to).replace(/\s+/g, " ").trim(), 300)}${suffix}`;
}

function extractSearchQueries(userPrompt: string): string[] {
  const candidates: string[] = [];

  for (const match of userPrompt.matchAll(/`([^`\n]+)`/g)) {
    candidates.push(match[1]);
  }
  for (const match of userPrompt.matchAll(/"([^"\n]+)"/g)) {
    candidates.push(match[1]);
  }
  for (const match of userPrompt.matchAll(/'([^'\n]+)'/g)) {
    candidates.push(match[1]);
  }
  for (const match of userPrompt.matchAll(/\b[A-Za-z_][A-Za-z0-9_.-]{2,}\b/g)) {
    candidates.push(match[0]);
  }
  for (const match of userPrompt.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    candidates.push(match[0]);
  }

  const seen = new Set<string>();
  return candidates
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 80)
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    })
    .slice(0, 8);
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
