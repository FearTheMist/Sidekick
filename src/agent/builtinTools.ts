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

export function createBuiltinToolRuntime(
  authGate: ToolAuthorizationGate
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
            String(args.path || ""),
            String(args.content || "")
          );
        case "modify_file":
          return modifyFileTool(
            authGate,
            String(args.path || ""),
            String(args.findText || ""),
            String(args.replaceText || "")
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
  path: string,
  content: string
): Promise<string> {
  const uri = await resolvePathWithAuthorization(auth, "write_file", path);
  if (!uri) {
    return "Denied";
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  return `Wrote ${path}`;
}

async function modifyFileTool(
  auth: ToolAuthorizationGate,
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
  if (!source.includes(findText)) {
    return "findText not found";
  }
  const result = source.replace(findText, replaceText);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(result, "utf8"));
  return `Modified ${path}`;
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
