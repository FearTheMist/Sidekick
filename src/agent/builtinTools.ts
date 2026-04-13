import * as vscode from "vscode";
import { exec } from "node:child_process";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { ToolDefinition } from "../core/llm";
import { ToolAuthorizationGate } from "./toolAuth";

const execAsync = promisify(exec);

interface BuiltinRuntime {
  definitions: ToolDefinition[];
  runTool: (name: string, argsText: string) => Promise<string>;
}

export interface WorkspaceMutation {
  path: string;
  existedBefore: boolean;
  previousContent?: string;
}

interface MutationTracker {
  mutations: WorkspaceMutation[];
}

export function createBuiltinToolRuntime(
  authGate: ToolAuthorizationGate,
  tracker?: MutationTracker
): BuiltinRuntime {
  const definitions: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read file content from workspace",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "read_directory",
      description: "List files in a workspace directory",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write file content in workspace",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "modify_file",
      description: "Replace text content in existing file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          findText: { type: "string" },
          replaceText: { type: "string" },
        },
        required: ["path", "findText", "replaceText"],
      },
    },
    {
      name: "edit_file",
      description:
        "Edit an existing file by replacing an exact or whitespace-trimmed text block",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["path", "oldString", "newString"],
      },
    },
    {
      name: "multi_edit_file",
      description:
        "Apply multiple ordered edits to the same file in one tool call",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldString: { type: "string" },
                newString: { type: "string" },
                replaceAll: { type: "boolean" },
              },
              required: ["oldString", "newString"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
    {
      name: "apply_patch",
      description:
        "Apply a structured multi-file patch with add, update, delete, and move operations",
      inputSchema: {
        type: "object",
        properties: {
          patchText: { type: "string" },
        },
        required: ["patchText"],
      },
    },
    {
      name: "search_project",
      description: "Search text across workspace files",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      name: "run_terminal_command",
      description: "Run terminal command in workspace",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  ];

  return {
    definitions,
    runTool: async (name: string, argsText: string) => {
      const args = parseArgs(argsText);
      switch (name) {
        case "read_file":
          return readFileTool(authGate, String(args.path || ""));
        case "read_directory":
          return readDirectoryTool(authGate, String(args.path || ""));
        case "write_file":
          return writeFileTool(
            authGate,
            tracker,
            String(args.path || ""),
            String(args.content || "")
          );
        case "modify_file":
          return modifyFileTool(
            authGate,
            tracker,
            String(args.path || ""),
            String(args.findText || ""),
            String(args.replaceText || "")
          );
        case "edit_file":
          return editFileTool(
            authGate,
            tracker,
            String(args.path || ""),
            String(args.oldString || ""),
            String(args.newString || ""),
            Boolean(args.replaceAll)
          );
        case "multi_edit_file":
          return multiEditFileTool(
            authGate,
            tracker,
            String(args.path || ""),
            Array.isArray(args.edits) ? args.edits : []
          );
        case "apply_patch":
          return applyPatchTool(
            authGate,
            tracker,
            String(args.patchText || "")
          );
        case "search_project":
          return searchProjectTool(authGate, String(args.query || ""));
        case "run_terminal_command":
          return runCommandTool(authGate, String(args.command || ""));
        default:
          return `Unknown tool: ${name}`;
      }
    },
  };
}

function parseArgs(argsText: string): any {
  try {
    return JSON.parse(argsText || "{}");
  } catch {
    return {};
  }
}

function getWorkspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("No workspace folder");
  }
  return folder.uri;
}

function resolveWorkspaceUri(path: string): vscode.Uri {
  const root = getWorkspaceRoot();
  const target = vscode.Uri.joinPath(root, path);
  const rootPath = normalizePath(root.fsPath);
  const targetPath = normalizePath(target.fsPath);
  if (!targetPath.startsWith(rootPath)) {
    throw new Error("Path escapes workspace");
  }
  return target;
}

async function resolvePathWithAuthorization(
  auth: ToolAuthorizationGate,
  toolName: string,
  path: string,
  extraDetail?: string
): Promise<vscode.Uri | undefined> {
  const root = getWorkspaceRoot();
  const targetFsPath = nodePath.isAbsolute(path)
    ? nodePath.resolve(path)
    : nodePath.resolve(root.fsPath, path);

  const rootPath = normalizePath(root.fsPath);
  const targetPath = normalizePath(targetFsPath);
  const insideWorkspace =
    targetPath === rootPath || targetPath.startsWith(`${rootPath}/`);

  if (!insideWorkspace) {
    const detail = [
      `Outside workspace path: ${targetFsPath}`,
      extraDetail || "",
    ]
      .filter(Boolean)
      .join("\n");
    const ok = await auth.authorize(toolName, detail);
    if (!ok) {
      return undefined;
    }
  }

  return vscode.Uri.file(targetFsPath);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

async function readFileTool(
  auth: ToolAuthorizationGate,
  path: string
): Promise<string> {
  const uri = await resolvePathWithAuthorization(auth, "read_file", path);
  if (!uri) {
    return "Denied";
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

async function readDirectoryTool(
  auth: ToolAuthorizationGate,
  path: string
): Promise<string> {
  const uri = await resolvePathWithAuthorization(
    auth,
    "read_directory",
    path || "."
  );
  if (!uri) {
    return "Denied";
  }

  const entries = await vscode.workspace.fs.readDirectory(uri);
  return entries
    .map(([name, type]) =>
      `${name} (${type === vscode.FileType.Directory ? "dir" : "file"})`
    )
    .join("\n");
}

async function writeFileTool(
  auth: ToolAuthorizationGate,
  tracker: MutationTracker | undefined,
  path: string,
  content: string
): Promise<string> {
  const uri = await resolvePathWithAuthorization(auth, "write_file", path);
  if (!uri) {
    return "Denied";
  }

  const previous = await readFileIfExists(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  tracker?.mutations.push({
    path: uri.fsPath,
    existedBefore: previous !== undefined,
    previousContent: previous,
  });
  return buildFileChangeResult(path, previous || "", content, previous !== undefined ? "Updated file." : "Created file.", uri);
}

async function modifyFileTool(
  auth: ToolAuthorizationGate,
  tracker: MutationTracker | undefined,
  path: string,
  findText: string,
  replaceText: string
): Promise<string> {
  const uri = await resolvePathWithAuthorization(
    auth,
    "modify_file",
    path,
    `find: ${findText.slice(0, 120)}`
  );
  if (!uri) {
    return "Denied";
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const source = Buffer.from(bytes).toString("utf8");
  if (!findText) {
    return "findText is empty";
  }
  const edit = applyEdit(source, findText, replaceText, false);
  if (!edit.ok) {
    return edit.message;
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(edit.content, "utf8"));
  tracker?.mutations.push({
    path: uri.fsPath,
    existedBefore: true,
    previousContent: source,
  });
  return buildFileChangeResult(
    path,
    source,
    edit.content,
    `Modified ${path}\n\n${buildEditSummary(edit)}`,
    uri
  );
}

async function editFileTool(
  auth: ToolAuthorizationGate,
  tracker: MutationTracker | undefined,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): Promise<string> {
  const uri = await resolvePathWithAuthorization(
    auth,
    "edit_file",
    path,
    `find: ${oldString.slice(0, 120)}`
  );
  if (!uri) {
    return "Denied";
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const source = Buffer.from(bytes).toString("utf8");
  const edit = applyEdit(source, oldString, newString, replaceAll);
  if (!edit.ok) {
    return edit.message;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(edit.content, "utf8"));
  tracker?.mutations.push({
    path: uri.fsPath,
    existedBefore: true,
    previousContent: source,
  });
  return buildFileChangeResult(
    path,
    source,
    edit.content,
    `Edited ${path}\n\n${buildEditSummary(edit)}`,
    uri
  );
}

async function multiEditFileTool(
  auth: ToolAuthorizationGate,
  tracker: MutationTracker | undefined,
  path: string,
  edits: Array<{ oldString?: unknown; newString?: unknown; replaceAll?: unknown }>
): Promise<string> {
  const uri = await resolvePathWithAuthorization(auth, "multi_edit_file", path);
  if (!uri) {
    return "Denied";
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const source = Buffer.from(bytes).toString("utf8");
  let current = source;
  const summaries: string[] = [];

  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    const result = applyEdit(
      current,
      String(edit.oldString || ""),
      String(edit.newString || ""),
      Boolean(edit.replaceAll)
    );
    if (!result.ok) {
      return `Edit ${index + 1} failed: ${result.message}`;
    }
    current = result.content;
    summaries.push(`Edit ${index + 1}: ${buildEditSummary(result)}`);
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(current, "utf8"));
  tracker?.mutations.push({
    path: uri.fsPath,
    existedBefore: true,
    previousContent: source,
  });
  return buildFileChangeResult(
    path,
    source,
    current,
    `Edited ${path} with ${edits.length} changes\n\n${summaries.join("\n")}`,
    uri
  );
}

async function readFileIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

interface EditResult {
  ok: boolean;
  content: string;
  replacements: number;
  strategy?:
    | "exact"
    | "line_trimmed"
    | "block_anchor"
    | "whitespace_normalized"
    | "indentation_flexible"
    | "trimmed_boundary"
    | "context_aware";
  message?: string;
}

type PatchOperation =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | {
      type: "update";
      path: string;
      moveTo?: string;
      hunks: PatchHunk[];
    };

interface PatchHunk {
  lines: string[];
}

function applyEdit(
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): EditResult {
  if (!oldString) {
    return {
      ok: false,
      content: source,
      replacements: 0,
      message: "oldString is empty",
    };
  }
  if (oldString === newString) {
    return {
      ok: false,
      content: source,
      replacements: 0,
      message: "oldString and newString are identical",
    };
  }

  for (const strategy of EDIT_STRATEGIES) {
    const result = applyStrategyReplace(source, oldString, newString, replaceAll, strategy);
    if (result.status === "matched") {
      return {
        ok: true,
        content: result.content,
        replacements: result.replacements,
        strategy: strategy.name,
      };
    }
    if (result.status === "ambiguous") {
      return {
        ok: false,
        content: source,
        replacements: 0,
        message:
          "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
      };
    }
  }

  return {
    ok: false,
    content: source,
    replacements: 0,
    message:
      "Could not find oldString in the file. Re-read the file and provide a larger or more exact block.",
  };
}

const EDIT_STRATEGIES = [
  { name: "exact", matcher: exactMatches },
  { name: "line_trimmed", matcher: lineTrimmedMatches },
  { name: "block_anchor", matcher: blockAnchorMatches },
  { name: "whitespace_normalized", matcher: whitespaceNormalizedMatches },
  { name: "indentation_flexible", matcher: indentationFlexibleMatches },
  { name: "trimmed_boundary", matcher: trimmedBoundaryMatches },
  { name: "context_aware", matcher: contextAwareMatches },
] as const;

function applyStrategyReplace(
  source: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  strategy: (typeof EDIT_STRATEGIES)[number]
):
  | { status: "none" }
  | { status: "ambiguous" }
  | { status: "matched"; content: string; replacements: number } {
  const matches = dedupeMatches(strategy.matcher(source, oldString));
  if (matches.length === 0) {
    return { status: "none" };
  }

  if (replaceAll) {
    let next = source;
    let replacements = 0;
    for (const match of matches) {
      if (!next.includes(match)) {
        continue;
      }
      next = next.split(match).join(newString);
      replacements += 1;
    }
    return replacements > 0
      ? { status: "matched", content: next, replacements }
      : { status: "none" };
  }

  if (matches.length > 1) {
    return { status: "ambiguous" };
  }

  const match = matches[0];
  const index = source.indexOf(match);
  if (index === -1) {
    return { status: "none" };
  }

  return {
    status: "matched",
    content: source.substring(0, index) + newString + source.substring(index + match.length),
    replacements: 1,
  };
}

function exactMatches(source: string, oldString: string): string[] {
  return source.includes(oldString) ? [oldString] : [];
}

function lineTrimmedMatches(source: string, oldString: string): string[] {
  const sourceLines = source.split("\n");
  const oldLines = stripTrailingEmptyLine(oldString.split("\n"));
  if (oldLines.length === 0) {
    return [];
  }

  const matches: string[] = [];
  for (let i = 0; i <= sourceLines.length - oldLines.length; i += 1) {
    let matched = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if ((sourceLines[i + j] || "").trim() !== oldLines[j].trim()) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push(sourceLines.slice(i, i + oldLines.length).join("\n"));
    }
  }

  return matches;
}

function blockAnchorMatches(source: string, oldString: string): string[] {
  const sourceLines = source.split("\n");
  const oldLines = stripTrailingEmptyLine(oldString.split("\n"));
  if (oldLines.length < 3) {
    return [];
  }

  const first = oldLines[0].trim();
  const last = oldLines[oldLines.length - 1].trim();
  const matches: string[] = [];
  for (let i = 0; i < sourceLines.length; i += 1) {
    if (sourceLines[i].trim() !== first) {
      continue;
    }
    for (let j = i + 2; j < sourceLines.length; j += 1) {
      if (sourceLines[j].trim() === last) {
        matches.push(sourceLines.slice(i, j + 1).join("\n"));
        break;
      }
    }
  }
  return matches;
}

function whitespaceNormalizedMatches(source: string, oldString: string): string[] {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const normalizedFind = normalize(oldString);
  const matches = new Set<string>();
  const lines = source.split("\n");

  for (const line of lines) {
    if (normalize(line) === normalizedFind) {
      matches.add(line);
    }
  }

  const findLines = oldString.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i += 1) {
      const block = lines.slice(i, i + findLines.length).join("\n");
      if (normalize(block) === normalizedFind) {
        matches.add(block);
      }
    }
  }

  return [...matches];
}

function indentationFlexibleMatches(source: string, oldString: string): string[] {
  const unindent = (value: string) => {
    const lines = value.split("\n");
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    if (nonEmpty.length === 0) {
      return value;
    }
    const minIndent = Math.min(
      ...nonEmpty.map((line) => {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
      })
    );
    return lines
      .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
      .join("\n");
  };

  const target = unindent(oldString);
  const sourceLines = source.split("\n");
  const oldLines = oldString.split("\n");
  const matches: string[] = [];
  for (let i = 0; i <= sourceLines.length - oldLines.length; i += 1) {
    const block = sourceLines.slice(i, i + oldLines.length).join("\n");
    if (unindent(block) === target) {
      matches.push(block);
    }
  }
  return matches;
}

function trimmedBoundaryMatches(source: string, oldString: string): string[] {
  const trimmed = oldString.trim();
  if (!trimmed || trimmed === oldString) {
    return [];
  }

  const matches = new Set<string>();
  if (source.includes(trimmed)) {
    matches.add(trimmed);
  }

  const sourceLines = source.split("\n");
  const oldLines = oldString.split("\n");
  for (let i = 0; i <= sourceLines.length - oldLines.length; i += 1) {
    const block = sourceLines.slice(i, i + oldLines.length).join("\n");
    if (block.trim() === trimmed) {
      matches.add(block);
    }
  }

  return [...matches];
}

function contextAwareMatches(source: string, oldString: string): string[] {
  const oldLines = stripTrailingEmptyLine(oldString.split("\n"));
  if (oldLines.length < 3) {
    return [];
  }

  const sourceLines = source.split("\n");
  const first = oldLines[0].trim();
  const last = oldLines[oldLines.length - 1].trim();
  const matches: string[] = [];

  for (let i = 0; i < sourceLines.length; i += 1) {
    if (sourceLines[i].trim() !== first) {
      continue;
    }
    for (let j = i + 2; j < sourceLines.length; j += 1) {
      if (sourceLines[j].trim() !== last) {
        continue;
      }

      const blockLines = sourceLines.slice(i, j + 1);
      if (blockLines.length !== oldLines.length) {
        break;
      }

      let matchingLines = 0;
      let totalNonEmpty = 0;
      for (let k = 1; k < blockLines.length - 1; k += 1) {
        const blockLine = blockLines[k].trim();
        const oldLine = oldLines[k].trim();
        if (blockLine.length > 0 || oldLine.length > 0) {
          totalNonEmpty += 1;
          if (blockLine === oldLine) {
            matchingLines += 1;
          }
        }
      }

      if (totalNonEmpty === 0 || matchingLines / totalNonEmpty >= 0.5) {
        matches.push(blockLines.join("\n"));
      }
      break;
    }
  }

  return matches;
}

function dedupeMatches(matches: string[]): string[] {
  return [...new Set(matches.filter(Boolean))];
}

function stripTrailingEmptyLine(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function buildEditSummary(edit: EditResult): string {
  return `strategy: ${edit.strategy || "unknown"}\nreplacements: ${edit.replacements}`;
}

function buildFileChangeResult(
  path: string,
  before: string,
  after: string,
  header: string,
  uri: vscode.Uri
): string {
  const diff = buildUnifiedSnippet(before, after);
  const diagnostics = formatDiagnostics(uri);
  return [header, diff, diagnostics].filter(Boolean).join("\n\n");
}

function buildDeletedFileResult(path: string, before: string): string {
  return [
    `Deleted ${path}`,
    buildUnifiedSnippet(before, ""),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildUnifiedSnippet(before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (
    beforeEnd >= start &&
    afterEnd >= start &&
    beforeLines[beforeEnd] === afterLines[afterEnd]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  if (start > beforeEnd && start > afterEnd) {
    return "No textual diff.";
  }

  const contextStart = Math.max(0, start - 2);
  const contextBeforeEnd = Math.min(beforeLines.length - 1, beforeEnd + 2);
  const contextAfterEnd = Math.min(afterLines.length - 1, afterEnd + 2);
  const lines: string[] = ["<diff>"];

  for (let i = contextStart; i <= contextBeforeEnd; i += 1) {
    if (i < start || i > beforeEnd) {
      lines.push(` ${beforeLines[i]}`);
    } else {
      lines.push(`-${beforeLines[i]}`);
    }
  }
  for (let i = start; i <= contextAfterEnd; i += 1) {
    if (i < start || i > afterEnd) {
      if (i > contextBeforeEnd) {
        lines.push(` ${afterLines[i]}`);
      }
    } else {
      lines.push(`+${afterLines[i]}`);
    }
  }

  lines.push("</diff>");
  return lines.join("\n");
}

function formatDiagnostics(uri: vscode.Uri): string {
  const diagnostics = vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error)
    .slice(0, 10);

  if (diagnostics.length === 0) {
    return "";
  }

  return [
    `LSP errors detected in ${vscode.workspace.asRelativePath(uri)}:`,
    ...diagnostics.map((item) => {
      const line = item.range.start.line + 1;
      const character = item.range.start.character + 1;
      return `${line}:${character} ${item.message}`;
    }),
  ].join("\n");
}

async function applyPatchTool(
  auth: ToolAuthorizationGate,
  tracker: MutationTracker | undefined,
  patchText: string
): Promise<string> {
  const operations = parsePatchText(patchText);
  if (operations.length === 0) {
    return "apply_patch verification failed: no operations found";
  }

  const authorizedPaths = new Set<string>();
  for (const operation of operations) {
    const paths = operation.type === "update" && operation.moveTo
      ? [operation.path, operation.moveTo]
      : [operation.path];
    for (const rawPath of paths) {
      const uri = await resolvePathWithAuthorization(auth, "apply_patch", rawPath);
      if (!uri) {
        return "Denied";
      }
      authorizedPaths.add(uri.fsPath);
    }
  }

  const changed: string[] = [];
  const tracked = new Set<string>();
  const summaries: string[] = [];

  for (const operation of operations) {
    if (operation.type === "add") {
      const target = resolveWorkspaceUri(operation.path);
      const previous = await readFileIfExists(target);
      if (previous !== undefined) {
        return `apply_patch verification failed: file already exists: ${operation.path}`;
      }
      await ensureParentDirectory(target);
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(operation.content, "utf8")
      );
      trackMutation(tracker, tracked, {
        path: target.fsPath,
        existedBefore: false,
      });
      changed.push(`A ${operation.path}`);
      summaries.push(
        buildFileChangeResult(operation.path, "", operation.content, `Added ${operation.path}`, target)
      );
      continue;
    }

    if (operation.type === "delete") {
      const target = resolveWorkspaceUri(operation.path);
      const previous = await readFileIfExists(target);
      if (previous === undefined) {
        return `apply_patch verification failed: file not found: ${operation.path}`;
      }
      trackMutation(tracker, tracked, {
        path: target.fsPath,
        existedBefore: true,
        previousContent: previous,
      });
      await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
      changed.push(`D ${operation.path}`);
      summaries.push(buildDeletedFileResult(operation.path, previous));
      continue;
    }

    const sourceUri = resolveWorkspaceUri(operation.path);
    const sourceContent = await readFileIfExists(sourceUri);
    if (sourceContent === undefined) {
      return `apply_patch verification failed: file not found: ${operation.path}`;
    }

    const nextContent = applyPatchHunks(sourceContent, operation.hunks);
    if (nextContent.ok === false) {
      const message = nextContent.message;
      return `apply_patch verification failed: ${message}`;
    }

    trackMutation(tracker, tracked, {
      path: sourceUri.fsPath,
      existedBefore: true,
      previousContent: sourceContent,
    });

    if (operation.moveTo) {
      const targetUri = resolveWorkspaceUri(operation.moveTo);
      const targetPrevious = await readFileIfExists(targetUri);
      trackMutation(tracker, tracked, {
        path: targetUri.fsPath,
        existedBefore: targetPrevious !== undefined,
        previousContent: targetPrevious,
      });
      await ensureParentDirectory(targetUri);
      await vscode.workspace.fs.writeFile(
        targetUri,
        Buffer.from(nextContent.content, "utf8")
      );
      await vscode.workspace.fs.delete(sourceUri, { recursive: false, useTrash: false });
      changed.push(`M ${operation.path} -> ${operation.moveTo}`);
      summaries.push(
        buildFileChangeResult(
          operation.moveTo,
          targetPrevious || "",
          nextContent.content,
          `Moved ${operation.path} -> ${operation.moveTo}`,
          targetUri
        )
      );
      continue;
    }

    await vscode.workspace.fs.writeFile(
      sourceUri,
      Buffer.from(nextContent.content, "utf8")
    );
    changed.push(`M ${operation.path}`);
    summaries.push(
      buildFileChangeResult(
        operation.path,
        sourceContent,
        nextContent.content,
        `Updated ${operation.path}`,
        sourceUri
      )
    );
  }

  return `Success. Updated the following files:\n${changed.join("\n")}\n\n${summaries.join("\n\n")}`;
}

function parsePatchText(patchText: string): PatchOperation[] {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("missing Begin marker");
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      return operations;
    }

    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) {
          throw new Error(`invalid add line in ${path}`);
        }
        contentLines.push(lines[index].slice(1));
        index += 1;
      }
      operations.push({
        type: "add",
        path,
        content: contentLines.join("\n"),
      });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      operations.push({
        type: "delete",
        path: line.slice("*** Delete File: ".length).trim(),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = lines[index].slice("*** Move to: ".length).trim();
        index += 1;
      }

      const hunks: PatchHunk[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("@@")) {
          throw new Error(`invalid hunk header in ${path}`);
        }
        index += 1;
        const hunkLines: string[] = [];
        while (
          index < lines.length &&
          !lines[index].startsWith("@@") &&
          !lines[index].startsWith("*** ")
        ) {
          hunkLines.push(lines[index]);
          index += 1;
        }
        hunks.push({ lines: hunkLines });
      }

      operations.push({ type: "update", path, moveTo, hunks });
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    throw new Error(`unknown patch section: ${line}`);
  }

  throw new Error("missing End marker");
}

function applyPatchHunks(
  source: string,
  hunks: PatchHunk[]
): { ok: true; content: string } | { ok: false; message: string } {
  let content = source;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      const prefix = line[0];
      const body = line.slice(1);
      if (prefix === " ") {
        oldLines.push(body);
        newLines.push(body);
        continue;
      }
      if (prefix === "-") {
        oldLines.push(body);
        continue;
      }
      if (prefix === "+") {
        newLines.push(body);
        continue;
      }
      throw new Error(`invalid hunk line: ${line}`);
    }

    const edit = applyEdit(content, oldLines.join("\n"), newLines.join("\n"), false);
    if (!edit.ok) {
      return { ok: false, message: edit.message || "failed to apply hunk" };
    }
    content = edit.content;
  }
  return { ok: true, content };
}

async function ensureParentDirectory(uri: vscode.Uri): Promise<void> {
  const dir = vscode.Uri.file(nodePath.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(dir);
}

function trackMutation(
  tracker: MutationTracker | undefined,
  tracked: Set<string>,
  mutation: WorkspaceMutation
): void {
  if (!tracker) {
    return;
  }
  if (tracked.has(mutation.path)) {
    return;
  }
  tracked.add(mutation.path);
  tracker.mutations.push(mutation);
}

async function searchProjectTool(
  _auth: ToolAuthorizationGate,
  query: string
): Promise<string> {
  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,.git,out,dist}/**",
    180
  );

  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= 200) {
      break;
    }

    let content = "";
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      content = Buffer.from(bytes).toString("utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(query)) {
        hits.push(`${vscode.workspace.asRelativePath(file)}:${i + 1}`);
      }
      if (hits.length >= 200) {
        break;
      }
    }
  }

  return hits.join("\n");
}

async function runCommandTool(
  auth: ToolAuthorizationGate,
  command: string
): Promise<string> {
  const ok = await auth.authorize("run_terminal_command", command);
  if (!ok) {
    return "Denied";
  }

  const root = getWorkspaceRoot();
  const { stdout, stderr } = await execAsync(command, { cwd: root.fsPath });
  return `stdout:\n${stdout}\n\nstderr:\n${stderr}`;
}
