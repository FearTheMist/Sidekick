import * as nodePath from "node:path";
import { PermissionRequest } from "./toolAuth";

const NESTED_SHELL_PATTERNS = [
  /(^|\s)bash\s+-c(\s|$)/i,
  /(^|\s)sh\s+-c(\s|$)/i,
  /(^|\s)powershell(?:\.exe)?\s+-command(\s|$)/i,
  /(^|\s)pwsh(?:\.exe)?\s+-command(\s|$)/i,
];

const NETWORK_PATTERNS = [
  /(^|\s)curl(\s|$)/i,
  /(^|\s)wget(\s|$)/i,
  /(^|\s)invoke-webrequest(\s|$)/i,
  /(^|\s)invoke-restmethod(\s|$)/i,
];

const DESTRUCTIVE_PATTERNS = [
  /(^|\s)rm(\s|$)/i,
  /(^|\s)del(\s|$)/i,
  /(^|\s)erase(\s|$)/i,
  /(^|\s)rmdir(\s|$)/i,
  /(^|\s)remove-item(\s|$)/i,
  /(^|\s)move(\s|$)/i,
  /(^|\s)mv(\s|$)/i,
  /(^|\s)ren(\s|$)/i,
  /(^|\s)rename-item(\s|$)/i,
];

const PROJECT_EXEC_PREFIXES = [
  "npm test",
  "npm run test",
  "npm run build",
  "pnpm test",
  "pnpm build",
  "yarn test",
  "yarn build",
  "cargo test",
  "go test",
  "pytest",
];

const PROJECT_MUTATION_PREFIXES = [
  "npm install",
  "pnpm install",
  "yarn add",
  "yarn install",
  "git add",
  "git commit",
];

const COMMAND_TOKEN_PATTERN = /"[^"]+"|'[^']+'|\S+/g;
const PATH_TOKEN_PATTERN = /(?:[A-Za-z]:[\\/][^\s"']+|\.\.[\\/][^\s"']*|\.\.[\\/]*|\/[^\s"']+)/g;

export function classifyTerminalCommand(
  command: string,
  workspaceRoot: string
): PermissionRequest[] {
  const requests: PermissionRequest[] = [];
  const normalized = command.trim();
  const added = new Set<string>();

  const add = (permission: string, pattern: string, detail: string) => {
    const key = `${permission}:${pattern}`;
    if (added.has(key)) {
      return;
    }
    added.add(key);
    requests.push({ permission, pattern, detail });
  };

  if (matchesAny(normalized, NESTED_SHELL_PATTERNS)) {
    add(
      "terminal_destructive",
      deriveCommandPattern("terminal_destructive", normalized),
      buildTerminalPermissionDetail(
        "destructive or nested shell command",
        normalized
      )
    );
  }

  if (matchesAny(normalized, NETWORK_PATTERNS)) {
    add(
      "terminal_network",
      deriveCommandPattern("terminal_network", normalized),
      buildTerminalPermissionDetail("network access", normalized)
    );
  }

  if (matchesAny(normalized, DESTRUCTIVE_PATTERNS)) {
    add(
      "terminal_destructive",
      deriveCommandPattern("terminal_destructive", normalized),
      buildTerminalPermissionDetail(
        "destructive or nested shell command",
        normalized
      )
    );
  }

  for (const externalPath of collectExternalPaths(normalized, workspaceRoot)) {
    add(
      "terminal_external_access",
      deriveExternalPathPattern(externalPath),
      buildTerminalPermissionDetail(
        "access files outside workspace",
        normalized,
        `Path: ${externalPath}`
      )
    );
  }

  if (matchesPrefix(normalized, PROJECT_EXEC_PREFIXES)) {
    add(
      "terminal_project_exec",
      deriveCommandPattern("terminal_project_exec", normalized),
      buildTerminalPermissionDetail(
        "run project validation command",
        normalized
      )
    );
  }

  if (matchesPrefix(normalized, PROJECT_MUTATION_PREFIXES)) {
    add(
      "terminal_project_mutation",
      deriveCommandPattern("terminal_project_mutation", normalized),
      buildTerminalPermissionDetail("modify project state", normalized)
    );
  }

  if (requests.length === 0) {
    add(
      "terminal_read",
      deriveCommandPattern("terminal_read", normalized),
      buildTerminalPermissionDetail("read project state", normalized)
    );
  }

  return requests;
}

export function buildTerminalPermissionDetail(
  _label: string,
  command: string,
  extra?: string
): string {
  return [`Command: ${command}`, extra || ""]
    .filter(Boolean)
    .join("\n");
}

export function deriveCommandPattern(
  permission: string,
  command: string
): string {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();

  if (permission === "terminal_read") {
    if (lower.startsWith("git status")) {
      return "git status*";
    }
    if (lower.startsWith("git diff")) {
      return "git diff*";
    }
    if (lower.startsWith("dir")) {
      return "dir*";
    }
    if (lower.startsWith("ls")) {
      return "ls*";
    }
  }

  if (permission === "terminal_project_exec") {
    const prefix = firstMatchingPrefix(trimmed, PROJECT_EXEC_PREFIXES);
    if (prefix) {
      return `${prefix}*`;
    }
  }

  if (permission === "terminal_project_mutation") {
    const prefix = firstMatchingPrefix(trimmed, PROJECT_MUTATION_PREFIXES);
    if (prefix) {
      return `${prefix}*`;
    }
  }

  const firstTwo = tokenizeCommand(trimmed).slice(0, 2).join(" ").trim();
  const firstOne = tokenizeCommand(trimmed).slice(0, 1).join(" ").trim();
  const basis = firstTwo || firstOne || trimmed;
  return `${basis}*`;
}

export function isPathOutsideWorkspace(
  rawPath: string,
  workspaceRoot: string
): boolean {
  const normalizedRoot = normalizePath(nodePath.resolve(workspaceRoot));
  const resolved = resolvePath(rawPath, workspaceRoot);
  const normalizedPath = normalizePath(resolved);
  return !(
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

function deriveExternalPathPattern(filePath: string): string {
  const resolved = normalizePath(nodePath.resolve(filePath));
  const dir = normalizePath(nodePath.dirname(resolved));
  return `${dir}/*`;
}

function collectExternalPaths(command: string, workspaceRoot: string): string[] {
  const matches = command.match(PATH_TOKEN_PATTERN) || [];
  const paths: string[] = [];
  for (const match of matches) {
    const token = stripQuotes(match);
    if (!token || !looksLikePathToken(token)) {
      continue;
    }
    if (isPathOutsideWorkspace(token, workspaceRoot)) {
      paths.push(resolvePath(token, workspaceRoot));
    }
  }
  return [...new Set(paths)];
}

function resolvePath(rawPath: string, workspaceRoot: string): string {
  return nodePath.isAbsolute(rawPath)
    ? nodePath.resolve(rawPath)
    : nodePath.resolve(workspaceRoot, rawPath);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function looksLikePathToken(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\.\.[\\/]*|\/)/.test(value);
}

function matchesAny(command: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(command));
}

function matchesPrefix(command: string, prefixes: string[]): boolean {
  const lower = command.toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix));
}

function firstMatchingPrefix(command: string, prefixes: string[]): string | undefined {
  const lower = command.toLowerCase();
  return prefixes.find((prefix) => lower.startsWith(prefix));
}

function tokenizeCommand(command: string): string[] {
  return (command.match(COMMAND_TOKEN_PATTERN) || []).map(stripQuotes);
}
