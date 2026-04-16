import * as vscode from "vscode";
import { SidekickConfig } from "../../core/config";
import { LlmGateway } from "../../core/llm";

interface CachedSuggestion {
  value: string;
  timestamp: number;
}

const CACHE_TTL_MS = 30_000;
const MIN_TRIGGER_MS = 800;
const REQUEST_DEBOUNCE_MS = 1000;

export class SidekickInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private cache = new Map<string, CachedSuggestion>();
  private inFlight = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly gateway: LlmGateway,
    private readonly output: vscode.OutputChannel
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    this.log(
      `trigger document=${document.uri.scheme}:${document.uri.path} line=${position.line} char=${position.character}`
    );

    if (!this.shouldSuggest(document, position)) {
      this.log("skip reason=unsupported_document");
      return [];
    }

    const key = this.toKey(document, position);
    const debounceScope = this.toDebounceScope(document, position);
    const cached = this.cache.get(key);

    this.scheduleDebouncedFetch(document, position, key, debounceScope, token);

    if (!cached || Date.now() - cached.timestamp > CACHE_TTL_MS) {
      this.log("cache miss");
      return [];
    }

    this.log(`cache hit age_ms=${Date.now() - cached.timestamp}`);

    return [
      new vscode.InlineCompletionItem(
        cached.value,
        new vscode.Range(position, position)
      ),
    ];
  }

  private async fetchSuggestion(
    document: vscode.TextDocument,
    position: vscode.Position,
    key: string,
    token: vscode.CancellationToken
  ): Promise<void> {
    const profile = SidekickConfig.getCompletionProfile();
    if (!profile.providerId || !profile.model) {
      this.log("skip reason=unconfigured_profile");
      return;
    }

    const prompt = this.buildPrompt(document, position);
    const startedAt = Date.now();
    let output = "";

    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    try {
      for await (const event of this.gateway.streamChat({
        profile,
        messages: [{ role: "user", content: prompt }],
        signal: abortController.signal,
      })) {
        if (event.type !== "text") {
          if (event.type === "error") {
            this.log(`stream error ${event.message}`);
          }
          continue;
        }

        output += event.delta;
        const sanitized = sanitizeCompletion(output);
        if (!sanitized) {
          continue;
        }

        this.cache.set(key, { value: sanitized, timestamp: Date.now() });
        this.log(
          `delta bytes=${event.delta.length} total=${sanitized.length} latency_ms=${Date.now() - startedAt}`
        );

        if (Date.now() - startedAt <= MIN_TRIGGER_MS || sanitized.length >= 24) {
          await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        }
      }
    } catch (error) {
      this.log(`fetch exception ${String(error)}`);
      return;
    }
  }

  async debugPing(): Promise<void> {
    const profile = SidekickConfig.getCompletionProfile();
    this.output.show(true);
    if (!profile.providerId || !profile.model) {
      this.log("debug ping skipped unconfigured_profile");
      return;
    }

    this.log(
      `debug ping provider=${profile.providerId} model=${profile.model || "(default)"}`
    );

    const startedAt = Date.now();
    let text = "";
    for await (const event of this.gateway.streamChat({
      profile,
      messages: [{ role: "user", content: "Reply with exactly: SIDEKICK_INLINE_OK" }],
    })) {
      if (event.type === "text") {
        text += event.delta;
      }
      if (event.type === "error") {
        this.log(`debug ping error ${event.message}`);
      }
    }

    this.log(
      `debug ping done latency_ms=${Date.now() - startedAt} output=${text.trim().slice(0, 120)}`
    );
  }

  private buildPrompt(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string {
    const lineText = document.lineAt(position.line).text;
    const prefix = lineText.slice(0, position.character);
    const suffix = lineText.slice(position.character);

    const contextStart = new vscode.Position(Math.max(0, position.line - 80), 0);
    const contextEnd = new vscode.Position(
      Math.min(document.lineCount - 1, position.line + 80),
      document.lineAt(Math.min(document.lineCount - 1, position.line + 80)).text
        .length
    );
    const surrounding = document.getText(new vscode.Range(contextStart, contextEnd));

    const instruction = this.findInstructionComment(document, position.line);

    return [
      "You are a VS Code inline code completion model.",
      "Output only the completion text without markdown fences.",
      "Support both single-line and multi-line completion.",
      "Prefer deterministic, minimal, syntax-correct output.",
      instruction ? `Natural language instruction near cursor:\n${instruction}` : "",
      `Language: ${document.languageId}`,
      "Surrounding code:",
      surrounding,
      "Cursor prefix:",
      prefix,
      "Cursor suffix:",
      suffix,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private findInstructionComment(
    document: vscode.TextDocument,
    cursorLine: number
  ): string {
    const lowerBound = Math.max(0, cursorLine - 4);
    for (let line = cursorLine; line >= lowerBound; line -= 1) {
      const text = document.lineAt(line).text.trim();
      if (!text) {
        continue;
      }
      if (
        text.startsWith("//") ||
        text.startsWith("#") ||
        text.startsWith("/*") ||
        text.startsWith("*") ||
        text.startsWith("--")
      ) {
        return text;
      }
      break;
    }
    return "";
  }

  private shouldSuggest(
    document: vscode.TextDocument,
    position: vscode.Position
  ): boolean {
    if (document.uri.scheme !== "file") {
      return false;
    }
    if (position.line >= document.lineCount) {
      return false;
    }
    return true;
  }

  private toKey(document: vscode.TextDocument, position: vscode.Position): string {
    const line = document.lineAt(position.line).text;
    const prefix = line.slice(0, position.character);
    const suffix = line.slice(position.character);
    return `${document.uri.toString()}#${position.line}:${position.character}|${prefix}|${suffix}`;
  }

  private toDebounceScope(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string {
    return `${document.uri.toString()}#${position.line}`;
  }

  private scheduleDebouncedFetch(
    document: vscode.TextDocument,
    position: vscode.Position,
    key: string,
    scope: string,
    token: vscode.CancellationToken
  ): void {
    const existing = this.debounceTimers.get(scope);
    if (existing) {
      clearTimeout(existing);
      this.log("debounce reset");
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(scope);

      if (token.isCancellationRequested) {
        this.log("debounce skipped canceled_request");
        return;
      }

      if (this.inFlight.has(key)) {
        this.log("debounce skipped in_flight");
        return;
      }

      this.log("fetch start");
      this.inFlight.add(key);
      void this.fetchSuggestion(document, position, key, token).finally(() => {
        this.inFlight.delete(key);
        this.log("fetch end");
      });
    }, REQUEST_DEBOUNCE_MS);

    this.debounceTimers.set(scope, timer);
    this.log(`debounce scheduled delay_ms=${REQUEST_DEBOUNCE_MS}`);
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function sanitizeCompletion(text: string): string {
  const trimmed = text.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trimEnd();
  return trimmed;
}
