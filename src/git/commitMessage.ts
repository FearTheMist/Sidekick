import * as vscode from "vscode";
import { execFile } from "child_process";

type GenerateText = (systemPrompt: string, userPrompt: string) => Promise<string>;

type GitContext = {
  source: "staged" | "unstaged";
  diff: string;
  recentCommitSubjects: string[];
};

type GitExtensionApi = {
  getAPI(version: number): {
    repositories: Array<{
      rootUri: vscode.Uri;
      inputBox: { value: string };
    }>;
  };
};

export async function generateCommitMessage(generateText: GenerateText): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder before generating commit messages.");
    return;
  }

  try {
    const gitContext = await collectGitContext(workspaceFolder.uri.fsPath);
    const config = vscode.workspace.getConfiguration("sidekick");
    const systemPrompt = config.get<string>(
      "commitMessagePrompt",
      "You are an expert software engineer writing concise git commit messages. Match the repository's existing commit style, focus on intent, and return only the commit message text."
    );

    const userPrompt = buildUserPrompt(gitContext);
    const raw = await generateText(systemPrompt, userPrompt);
    const commitMessage = sanitizeCommitMessage(raw);

    if (!commitMessage) {
      vscode.window.showErrorMessage("Generated commit message is empty.");
      return;
    }

    await vscode.commands.executeCommand("workbench.view.scm");
    const applied = await tryApplyCommitMessageToScmInput(commitMessage, workspaceFolder.uri.fsPath);
    if (!applied) {
      await vscode.env.clipboard.writeText(commitMessage);
      vscode.window.showWarningMessage("Could not write to SCM input box. Commit message copied to clipboard.");
      return;
    }

    vscode.window.showInformationMessage(
      `Commit message generated from ${gitContext.source === "staged" ? "staged" : "unstaged"} changes.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate commit message.";
    vscode.window.showErrorMessage(message);
  }
}

async function tryApplyCommitMessageToScmInput(commitMessage: string, workspacePath: string): Promise<boolean> {
  const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git");
  if (!gitExtension) {
    return false;
  }

  if (!gitExtension.isActive) {
    await gitExtension.activate();
  }

  const gitApi = gitExtension.exports?.getAPI?.(1);
  const repositories = gitApi?.repositories ?? [];
  if (repositories.length === 0) {
    return false;
  }

  const workspacePathNormalized = workspacePath.replace(/\\/g, "/").toLowerCase();
  const targetRepo =
    repositories.find((repo) => repo.rootUri.fsPath.replace(/\\/g, "/").toLowerCase() === workspacePathNormalized) ??
    repositories[0];

  if (!targetRepo?.inputBox) {
    return false;
  }

  await delay(40);
  targetRepo.inputBox.value = commitMessage;
  return true;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function collectGitContext(cwd: string): Promise<GitContext> {
  const stagedDiff = (await runGit(["diff", "--cached"], cwd)).trim();
  const unstagedDiff = (await runGit(["diff"], cwd)).trim();

  const source: "staged" | "unstaged" = stagedDiff ? "staged" : "unstaged";
  const diff = stagedDiff || unstagedDiff;
  if (!diff) {
    throw new Error("No staged or unstaged changes found.");
  }

  const recent = await runGit(["log", "-12", "--pretty=format:%s"], cwd);
  const recentCommitSubjects = recent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => Boolean(line));

  return {
    source,
    diff,
    recentCommitSubjects
  };
}

function buildUserPrompt(context: GitContext): string {
  const styleExamples = context.recentCommitSubjects.length > 0 ? context.recentCommitSubjects.join("\n") : "(none)";

  return [
    `Primary source: ${context.source} diff`,
    "",
    "Recent commit message subjects (match style):",
    styleExamples,
    "",
    "Git diff:",
    context.diff,
    "",
    "Return requirements:",
    "- Return only the final commit message text",
    "- Prefer one concise subject line",
    "- Follow repository style from examples",
    "- Focus on intent and impact"
  ].join("\n");
}

function sanitizeCommitMessage(raw: string): string {
  const trimmed = raw.trim().replace(/^```[a-zA-Z]*\n?/g, "").replace(/```$/g, "").trim();
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => Boolean(line));
  return lines.length > 0 ? lines[0] : "";
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
