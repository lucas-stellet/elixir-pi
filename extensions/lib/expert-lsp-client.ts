import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compactOutput,
  DEFAULT_LONG_TIMEOUT_MS,
  exists,
  findMixRoot,
  isElixirLikeFile,
  parseArgs,
  resolveFromCwd,
  runCommand,
} from "./elixir-utils.ts";

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;

type Diagnostic = {
  range?: Range;
  severity?: number;
  code?: string | number;
  source?: string;
  message?: string;
  relatedInformation?: Array<{ location?: Location; message?: string }>;
};

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Location = { uri: string; range: Range };
type LocationLink = {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange?: Range;
  originSelectionRange?: Range;
};

type TextEdit = { range: Range; newText: string; annotationId?: string };
type TextDocumentIdentifier = { uri: string };
type VersionedTextDocumentIdentifier = TextDocumentIdentifier & { version?: number | null };
type TextDocumentEdit = { textDocument: VersionedTextDocumentIdentifier; edits: TextEdit[] };
type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<TextDocumentEdit | ResourceOperation | unknown>;
};
type ResourceOperation =
  | { kind: "create"; uri: string; options?: JsonObject; annotationId?: string }
  | { kind: "rename"; oldUri: string; newUri: string; options?: JsonObject; annotationId?: string }
  | { kind: "delete"; uri: string; options?: JsonObject; annotationId?: string };
type ApplyWorkspaceEditParams = { label?: string; edit?: WorkspaceEdit };
type WorkspaceTextEditBatch = { uri: string; edits: TextEdit[] };

type OpenDocument = {
  path: string;
  uri: string;
  languageId: string;
  version: number;
  text: string;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abortListener?: () => void;
};

type ExpertSessionStatus = {
  root: string;
  command: string;
  args: string[];
  running: boolean;
  initialized: boolean;
  openDocuments: number;
  diagnosticFiles: number;
  log: string[];
};

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_DIAGNOSTIC_WAIT_MS = 900;
const MAX_LOG_LINES = 80;
const sessions = new Map<string, ExpertLspSession>();

function rootUri(root: string): string {
  return pathToFileURL(root.endsWith(path.sep) ? root : `${root}${path.sep}`).toString();
}

function uriForPath(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function pathForUri(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

function languageIdForPath(filePath: string): string {
  const ext = path.extname(filePath);
  if (ext === ".heex") return "heex";
  if (ext === ".leex") return "eelixir";
  return "elixir";
}

function displayPath(uriOrPath: string, root: string): string {
  const filePath = uriOrPath.startsWith("file:") ? pathForUri(uriOrPath) : uriOrPath;
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

function toZeroBased(value: number | undefined, fallback = 1): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(raw) - 1);
}

function oneBased(position: Position | undefined): string {
  if (!position) return "?";
  return `${position.line + 1}:${position.character + 1}`;
}

function severityName(severity: number | undefined): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "diagnostic";
  }
}

function truncateJson(value: unknown): string {
  return compactOutput(JSON.stringify(value, null, 2) ?? "null", 6_000);
}

function markupToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markupToText).filter(Boolean).join("\n\n");
  if (typeof value === "object") {
    const record = value as JsonObject;
    if (typeof record.value === "string") return record.value;
    if (typeof record.language === "string" && typeof record.value === "string") return `\`\`\`${record.language}\n${record.value}\n\`\`\``;
    if (record.contents) return markupToText(record.contents);
  }
  return truncateJson(value);
}

function formatRange(range: Range | undefined): string {
  if (!range) return "?:?";
  return `${oneBased(range.start)}-${oneBased(range.end)}`;
}

function isLocation(value: unknown): value is Location {
  return Boolean(value && typeof value === "object" && typeof (value as Location).uri === "string" && (value as Location).range);
}

function isLocationLink(value: unknown): value is LocationLink {
  return Boolean(value && typeof value === "object" && typeof (value as LocationLink).targetUri === "string" && (value as LocationLink).targetRange);
}

function normalizeLocations(value: unknown): Array<Location | LocationLink> {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is Location | LocationLink => isLocation(item) || isLocationLink(item));
}

function splitExpertCommandFromEnv(): { command: string; args: string[] } {
  const command = process.env.PI_ELIXIR_EXPERT_COMMAND?.trim() || "expert";
  const envArgs = process.env.PI_ELIXIR_EXPERT_ARGS?.trim();
  const args = envArgs ? parseArgs(envArgs) : ["--stdio"];
  return { command, args };
}

function makeInitializeParams(root: string): JsonObject {
  return {
    processId: process.pid,
    clientInfo: { name: "elixir-pi", version: "0.3.0" },
    locale: "en",
    rootPath: root,
    rootUri: rootUri(root),
    workspaceFolders: [{ uri: rootUri(root), name: path.basename(root) || root }],
    initializationOptions: {},
    capabilities: {
      general: {
        positionEncodings: ["utf-16"],
        markdown: { parser: "marked", version: "1.0.0" },
      },
      window: {
        workDoneProgress: true,
        showMessage: { messageActionItem: { additionalPropertiesSupport: true } },
      },
      workspace: {
        applyEdit: true,
        workspaceEdit: {
          documentChanges: true,
          normalizesLineEndings: true,
          failureHandling: "textOnlyTransactional",
        },
        configuration: true,
        workspaceFolders: true,
        didChangeConfiguration: { dynamicRegistration: true },
        didChangeWatchedFiles: { dynamicRegistration: true },
        symbol: { dynamicRegistration: true },
        executeCommand: { dynamicRegistration: true },
      },
      textDocument: {
        synchronization: {
          dynamicRegistration: true,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: true,
        },
        publishDiagnostics: {
          relatedInformation: true,
          codeDescriptionSupport: true,
          dataSupport: true,
        },
        hover: {
          dynamicRegistration: true,
          contentFormat: ["markdown", "plaintext"],
        },
        definition: {
          dynamicRegistration: true,
          linkSupport: true,
        },
        references: {
          dynamicRegistration: true,
        },
        documentSymbol: {
          dynamicRegistration: true,
          hierarchicalDocumentSymbolSupport: true,
          labelSupport: true,
        },
        completion: {
          dynamicRegistration: true,
          contextSupport: true,
          completionItem: {
            snippetSupport: false,
            documentationFormat: ["markdown", "plaintext"],
            deprecatedSupport: true,
            preselectSupport: true,
          },
        },
      },
    },
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isTextEdit(value: unknown): value is TextEdit {
  if (!isJsonObject(value)) return false;
  const range = value.range as Range | undefined;
  return (
    typeof value.newText === "string" &&
    Boolean(range?.start && range?.end) &&
    typeof range.start.line === "number" &&
    typeof range.start.character === "number" &&
    typeof range.end.line === "number" &&
    typeof range.end.character === "number"
  );
}

function isTextDocumentEdit(value: unknown): value is TextDocumentEdit {
  if (!isJsonObject(value)) return false;
  const textDocument = value.textDocument as VersionedTextDocumentIdentifier | undefined;
  return Boolean(textDocument && typeof textDocument.uri === "string" && Array.isArray(value.edits) && value.edits.every(isTextEdit));
}

function isResourceOperation(value: unknown): value is ResourceOperation {
  return isJsonObject(value) && typeof value.kind === "string" && ["create", "rename", "delete"].includes(value.kind);
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13 || code === 10) {
      if (code === 13 && index + 1 < text.length && text.charCodeAt(index + 1) === 10) index += 1;
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function lineContentEnd(text: string, offsets: number[], line: number): number {
  let end = line + 1 < offsets.length ? offsets[line + 1] : text.length;
  while (end > offsets[line]) {
    const code = text.charCodeAt(end - 1);
    if (code !== 10 && code !== 13) break;
    end -= 1;
  }
  return end;
}

function offsetAt(text: string, position: Position): number {
  const offsets = lineOffsets(text);
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) {
    throw new Error(`Invalid LSP position ${position.line}:${position.character}.`);
  }
  if (position.line >= offsets.length) {
    throw new Error(`LSP edit points to line ${position.line + 1}, but file has ${offsets.length} line(s).`);
  }

  const start = offsets[position.line];
  const end = lineContentEnd(text, offsets, position.line);
  if (start + position.character > end) {
    throw new Error(`LSP edit points past end of line at ${position.line + 1}:${position.character + 1}.`);
  }
  return start + position.character;
}

function applyTextEditsToString(text: string, edits: TextEdit[]): string {
  if (edits.length === 0) return text;

  const normalized = edits.map((edit) => {
    const start = offsetAt(text, edit.range.start);
    const end = offsetAt(text, edit.range.end);
    if (start > end) throw new Error(`Invalid LSP edit range ${formatRange(edit.range)}.`);
    return { start, end, newText: edit.newText, range: edit.range };
  });

  normalized.sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = -1;
  for (const edit of normalized) {
    if (edit.start < previousEnd) {
      throw new Error(`Overlapping LSP edits are not supported near ${formatRange(edit.range)}.`);
    }
    previousEnd = edit.end;
  }

  let next = text;
  for (const edit of normalized.sort((a, b) => b.start - a.start || b.end - a.end)) {
    next = `${next.slice(0, edit.start)}${edit.newText}${next.slice(edit.end)}`;
  }
  return next;
}

function collectWorkspaceTextEdits(edit: WorkspaceEdit | undefined): { batches: WorkspaceTextEditBatch[]; unsupported: string[] } {
  const batches: WorkspaceTextEditBatch[] = [];
  const unsupported: string[] = [];
  if (!edit) return { batches, unsupported: ["missing WorkspaceEdit"] };

  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (isTextDocumentEdit(change)) {
        batches.push({ uri: change.textDocument.uri, edits: change.edits });
        continue;
      }
      if (isResourceOperation(change)) {
        unsupported.push(`resource operation '${change.kind}'`);
        continue;
      }
      unsupported.push(`unknown documentChanges item: ${truncateJson(change)}`);
    }
    return { batches, unsupported };
  }

  if (edit.changes && typeof edit.changes === "object") {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (!Array.isArray(edits) || !edits.every(isTextEdit)) {
        unsupported.push(`invalid text edits for ${uri}`);
        continue;
      }
      batches.push({ uri, edits });
    }
  }

  return { batches, unsupported };
}

function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("Operation aborted."));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Operation aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

export class ExpertLspSession {
  readonly root: string;
  readonly command: string;
  readonly args: string[];

  private child: ChildProcessWithoutNullStreams | undefined;
  private initialized = false;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly openDocuments = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly log: string[] = [];
  private startPromise: Promise<void> | undefined;

  constructor(root: string, command: string, args: string[]) {
    this.root = root;
    this.command = command;
    this.args = args;
  }

  status(): ExpertSessionStatus {
    return {
      root: this.root,
      command: this.command,
      args: this.args,
      running: Boolean(this.child && !this.child.killed),
      initialized: this.initialized,
      openDocuments: this.openDocuments.size,
      diagnosticFiles: this.diagnostics.size,
      log: [...this.log],
    };
  }

  diagnosticCounts(): { errors: number; warnings: number; infos: number; hints: number } {
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    let hints = 0;
    for (const diagnostics of this.diagnostics.values()) {
      for (const d of diagnostics) {
        switch (d.severity) {
          case 1: errors++; break;
          case 2: warnings++; break;
          case 3: infos++; break;
          case 4: hints++; break;
        }
      }
    }
    return { errors, warnings, infos, hints };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.initialized && this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal(signal).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async restart(signal?: AbortSignal): Promise<void> {
    await this.shutdown();
    this.initialized = false;
    this.openDocuments.clear();
    this.diagnostics.clear();
    await this.start(signal);
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;

    try {
      if (this.initialized && !child.killed) {
        await this.request("shutdown", {}, DEFAULT_REQUEST_TIMEOUT_MS).catch(() => undefined);
        this.notify("exit", {});
      }
    } finally {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Expert LSP session stopped before response to ${pending.method} (${String(id)}).`));
      }
      this.pending.clear();
      child.kill("SIGTERM");
      this.child = undefined;
      this.initialized = false;
    }
  }

  async syncDocument(filePath: string, signal?: AbortSignal): Promise<OpenDocument> {
    await this.start(signal);

    const absolutePath = resolveFromCwd(filePath, this.root);
    if (!(await exists(absolutePath))) throw new Error(`File does not exist: ${absolutePath}`);
    if (!isElixirLikeFile(absolutePath)) {
      throw new Error(`Expert only supports Elixir-ish files (.ex, .exs, .heex, .leex). Got: ${absolutePath}`);
    }

    const uri = uriForPath(absolutePath);
    const text = await fs.readFile(absolutePath, "utf8");
    const existing = this.openDocuments.get(uri);

    if (!existing) {
      const doc: OpenDocument = {
        path: absolutePath,
        uri,
        languageId: languageIdForPath(absolutePath),
        version: 1,
        text,
      };
      this.openDocuments.set(uri, doc);
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: doc.languageId,
          version: doc.version,
          text,
        },
      });
      this.notify("textDocument/didSave", { textDocument: { uri }, text });
      return doc;
    }

    if (existing.text !== text) {
      existing.version += 1;
      existing.text = text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      });
      this.notify("textDocument/didSave", { textDocument: { uri }, text });
    }

    return existing;
  }

  async diagnosticsFor(filePath?: string, waitMs = DEFAULT_DIAGNOSTIC_WAIT_MS, signal?: AbortSignal): Promise<string> {
    if (filePath) {
      const doc = await this.syncDocument(filePath, signal);
      await sleep(waitMs, signal).catch(() => undefined);
      const diagnostics = this.diagnostics.get(doc.uri) ?? [];
      return this.formatDiagnostics(doc.uri, diagnostics);
    }

    await this.start(signal);
    await sleep(waitMs, signal).catch(() => undefined);

    if (this.diagnostics.size === 0) {
      return "No diagnostics have been published yet. Open a file first, or wait for Expert to finish indexing.";
    }

    const sections = [...this.diagnostics.entries()]
      .sort(([a], [b]) => displayPath(a, this.root).localeCompare(displayPath(b, this.root)))
      .map(([uri, diagnostics]) => this.formatDiagnostics(uri, diagnostics));
    return sections.join("\n\n");
  }

  async hover(filePath: string, line: number | undefined, character: number | undefined, signal?: AbortSignal): Promise<string> {
    const doc = await this.syncDocument(filePath, signal);
    const result = await this.request(
      "textDocument/hover",
      {
        textDocument: { uri: doc.uri },
        position: { line: toZeroBased(line), character: toZeroBased(character) },
      },
      DEFAULT_REQUEST_TIMEOUT_MS,
      signal,
    );

    if (!result) return `No hover result for ${displayPath(doc.uri, this.root)} at ${line ?? "?"}:${character ?? "?"}.`;
    const record = result as JsonObject;
    const contents = markupToText(record.contents ?? result);
    const range = record.range ? `\nRange: ${formatRange(record.range as Range)}` : "";
    return [`# Expert hover`, `File: ${displayPath(doc.uri, this.root)}`, `Position: ${line ?? "?"}:${character ?? "?"}${range}`, "", contents || truncateJson(result)].join("\n");
  }

  async definition(filePath: string, line: number | undefined, character: number | undefined, signal?: AbortSignal): Promise<string> {
    const doc = await this.syncDocument(filePath, signal);
    const result = await this.request(
      "textDocument/definition",
      {
        textDocument: { uri: doc.uri },
        position: { line: toZeroBased(line), character: toZeroBased(character) },
      },
      DEFAULT_REQUEST_TIMEOUT_MS,
      signal,
    );

    return this.formatLocations("Expert definition", result);
  }

  async references(
    filePath: string,
    line: number | undefined,
    character: number | undefined,
    includeDeclaration = true,
    signal?: AbortSignal,
  ): Promise<string> {
    const doc = await this.syncDocument(filePath, signal);
    const result = await this.request(
      "textDocument/references",
      {
        textDocument: { uri: doc.uri },
        position: { line: toZeroBased(line), character: toZeroBased(character) },
        context: { includeDeclaration },
      },
      DEFAULT_LONG_TIMEOUT_MS,
      signal,
    );

    return this.formatLocations("Expert references", result);
  }

  async documentSymbols(filePath: string, signal?: AbortSignal): Promise<string> {
    const doc = await this.syncDocument(filePath, signal);
    const result = await this.request(
      "textDocument/documentSymbol",
      { textDocument: { uri: doc.uri } },
      DEFAULT_REQUEST_TIMEOUT_MS,
      signal,
    );

    const symbols = Array.isArray(result) ? result : [];
    if (symbols.length === 0) return `No document symbols returned for ${displayPath(doc.uri, this.root)}.`;
    return [`# Expert document symbols`, `File: ${displayPath(doc.uri, this.root)}`, "", ...this.formatSymbols(symbols)].join("\n");
  }

  async completion(filePath: string, line: number | undefined, character: number | undefined, signal?: AbortSignal): Promise<string> {
    const doc = await this.syncDocument(filePath, signal);
    const result = await this.request(
      "textDocument/completion",
      {
        textDocument: { uri: doc.uri },
        position: { line: toZeroBased(line), character: toZeroBased(character) },
        context: { triggerKind: 1 },
      },
      DEFAULT_REQUEST_TIMEOUT_MS,
      signal,
    );

    const items = Array.isArray(result) ? result : Array.isArray((result as JsonObject | undefined)?.items) ? ((result as JsonObject).items as unknown[]) : [];
    if (items.length === 0) return `No completions returned for ${displayPath(doc.uri, this.root)} at ${line ?? "?"}:${character ?? "?"}.`;

    const lines = items.slice(0, 50).map((item, index) => {
      if (!item || typeof item !== "object") return `${index + 1}. ${String(item)}`;
      const record = item as JsonObject;
      const label = String(record.label ?? record.insertText ?? "<unknown>");
      const detail = typeof record.detail === "string" ? ` — ${record.detail}` : "";
      const docText = record.documentation ? `\n   ${markupToText(record.documentation).split("\n")[0]}` : "";
      return `${index + 1}. ${label}${detail}${docText}`;
    });

    const more = items.length > 50 ? `\n... ${items.length - 50} more completions omitted.` : "";
    return [`# Expert completions`, `File: ${displayPath(doc.uri, this.root)}`, `Position: ${line ?? "?"}:${character ?? "?"}`, "", lines.join("\n") + more].join("\n");
  }

  async rename(
    filePath: string,
    line: number | undefined,
    character: number | undefined,
    newName: string,
    apply = false,
    signal?: AbortSignal,
  ): Promise<string> {
    const doc = await this.syncDocument(filePath, signal);
    const result = await this.request(
      "textDocument/rename",
      {
        textDocument: { uri: doc.uri },
        position: { line: toZeroBased(line), character: toZeroBased(character) },
        newName,
      },
      DEFAULT_LONG_TIMEOUT_MS,
      signal,
    );

    const edit = result as WorkspaceEdit | undefined;
    const summary = this.formatWorkspaceEdit("Expert rename", edit);
    if (!apply) return `${summary}\n\nPreview only. Re-run with apply=true to write these edits.`;

    const applied = await this.applyWorkspaceEdit(edit, `rename to ${newName}`);
    return `${summary}\n\n${applied}`;
  }

  async formatting(filePath: string, apply = false, signal?: AbortSignal): Promise<string> {
    const doc = await this.syncDocument(filePath, signal);
    const result = await this.request(
      "textDocument/formatting",
      {
        textDocument: { uri: doc.uri },
        options: { tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true, insertFinalNewline: true },
      },
      DEFAULT_LONG_TIMEOUT_MS,
      signal,
    );

    const edits = Array.isArray(result) && result.every(isTextEdit) ? (result as TextEdit[]) : [];
    const edit: WorkspaceEdit = { changes: { [doc.uri]: edits } };
    const summary = this.formatWorkspaceEdit("Expert formatting", edit);
    if (!apply) return `${summary}\n\nPreview only. Re-run with apply=true to write these edits.`;

    const applied = await this.applyWorkspaceEdit(edit, `format ${displayPath(doc.uri, this.root)}`);
    return `${summary}\n\n${applied}`;
  }

  private async startInternal(signal?: AbortSignal): Promise<void> {
    this.appendLog(`Starting ${this.command} ${this.args.join(" ")} in ${this.root}`);

    this.child = spawn(this.command, this.args, {
      cwd: this.root,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
    });

    const child = this.child;
    child.stdout.on("data", (chunk: Buffer) => this.handleData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendLog(chunk.toString().trim()));
    child.on("error", (error) => {
      this.appendLog(`process error: ${error.message}`);
      this.rejectAll(error);
    });
    child.on("exit", (code, signalName) => {
      this.appendLog(`process exited code=${code ?? "null"} signal=${signalName ?? "null"}`);
      this.initialized = false;
      this.rejectAll(new Error(`Expert exited code=${code ?? "null"} signal=${signalName ?? "null"}`));
    });

    const result = await this.request("initialize", makeInitializeParams(this.root), DEFAULT_LONG_TIMEOUT_MS, signal);
    this.appendLog(`initialize result: ${compactOutput(JSON.stringify(result ?? null), 1_500)}`);
    this.notify("initialized", {});
    this.initialized = true;
  }

  private request(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error("Expert LSP process is not running."));
    if (signal?.aborted) return Promise.reject(new Error("Operation aborted."));

    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Expert response to ${method}.`));
      }, timeoutMs);
      timer.unref?.();

      const pending: PendingRequest = { method, resolve, reject, timer };
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("Operation aborted."));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.abortListener = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, pending);
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        pending.abortListener?.();
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child || this.child.killed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private respond(id: JsonRpcId, result: unknown, error?: unknown): void {
    if (!this.child || this.child.killed) return;
    if (error) {
      this.write({ jsonrpc: "2.0", id, error });
    } else {
      this.write({ jsonrpc: "2.0", id, result });
    }
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.killed) throw new Error("Expert LSP process is not running.");
    child.stdin.write(encodeMessage(message));
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.appendLog(`Malformed LSP header: ${header}`);
        this.buffer = Buffer.alloc(0);
        return;
      }

      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;

      const body = this.buffer.slice(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.slice(bodyStart + length);

      try {
        this.dispatch(JSON.parse(body) as JsonObject);
      } catch (error) {
        this.appendLog(`Failed to parse LSP message: ${error instanceof Error ? error.message : String(error)} body=${compactOutput(body, 2_000)}`);
      }
    }
  }

  private dispatch(message: JsonObject): void {
    const id = message.id as JsonRpcId | undefined;
    const method = typeof message.method === "string" ? message.method : undefined;

    if (method && id !== undefined) {
      this.handleServerRequest(id, method, message.params);
      return;
    }

    if (method) {
      this.handleServerNotification(method, message.params);
      return;
    }

    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.abortListener?.();
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${truncateJson(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    switch (method) {
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        this.respond(id, null);
        return;

      case "workspace/configuration": {
        const items = Array.isArray((params as JsonObject | undefined)?.items) ? ((params as JsonObject).items as unknown[]) : [];
        this.respond(id, items.map(() => ({})));
        return;
      }

      case "workspace/workspaceFolders":
        this.respond(id, [{ uri: rootUri(this.root), name: path.basename(this.root) || this.root }]);
        return;

      case "window/showMessageRequest":
        this.appendLog(`showMessageRequest: ${truncateJson(params)}`);
        this.respond(id, null);
        return;

      case "workspace/applyEdit":
        void this.handleApplyEditRequest(id, params);
        return;

      default:
        this.appendLog(`Unhandled server request ${method}: ${truncateJson(params)}`);
        this.respond(id, null);
    }
  }

  private handleServerNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const record = params as JsonObject;
      const uri = typeof record.uri === "string" ? record.uri : undefined;
      const diagnostics = Array.isArray(record.diagnostics) ? (record.diagnostics as Diagnostic[]) : [];
      if (uri) this.diagnostics.set(uri, diagnostics);
      return;
    }

    if (method === "window/logMessage" || method === "window/showMessage" || method === "telemetry/event") {
      this.appendLog(`${method}: ${truncateJson(params)}`);
      return;
    }

    if (method.startsWith("$/") || method.endsWith("/refresh")) return;
    this.appendLog(`notification ${method}: ${truncateJson(params)}`);
  }

  private async handleApplyEditRequest(id: JsonRpcId, params: unknown): Promise<void> {
    const request = params as ApplyWorkspaceEditParams | undefined;
    try {
      const summary = await this.applyWorkspaceEdit(request?.edit, request?.label ?? "workspace/applyEdit");
      this.appendLog(summary);
      this.respond(id, { applied: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendLog(`workspace/applyEdit failed: ${message}`);
      this.respond(id, { applied: false, failureReason: message });
    }
  }

  private resolveEditableFileUri(uri: string): string {
    if (!uri.startsWith("file:")) throw new Error(`Only file: URIs can be edited by Expert. Got: ${uri}`);
    const filePath = path.resolve(pathForUri(uri));
    const relative = path.relative(this.root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing Expert edit outside workspace root: ${displayPath(uri, this.root)}`);
    }
    return filePath;
  }

  private async applyWorkspaceEdit(edit: WorkspaceEdit | undefined, label: string): Promise<string> {
    const { batches, unsupported } = collectWorkspaceTextEdits(edit);
    if (unsupported.length > 0) throw new Error(`Unsupported WorkspaceEdit from Expert: ${unsupported.join(", ")}.`);
    if (batches.length === 0) return `Expert applyEdit '${label}': no text edits to apply.`;

    let editCount = 0;
    const touched = new Set<string>();

    for (const batch of batches) {
      const absolutePath = this.resolveEditableFileUri(batch.uri);
      await withFileMutationQueue(absolutePath, async () => {
        const before = await fs.readFile(absolutePath, "utf8");
        const after = applyTextEditsToString(before, batch.edits);
        if (after !== before) {
          await fs.writeFile(absolutePath, after, "utf8");
          this.updateOpenDocumentAfterExternalEdit(absolutePath, after);
          touched.add(absolutePath);
        }
      });
      editCount += batch.edits.length;
    }

    const files = [...touched].sort().map((file) => `- ${displayPath(file, this.root)}`).join("\n");
    return [`Expert applyEdit '${label}': applied ${editCount} text edit(s) across ${touched.size} file(s).`, files].filter(Boolean).join("\n");
  }

  private updateOpenDocumentAfterExternalEdit(absolutePath: string, text: string): void {
    const uri = uriForPath(absolutePath);
    const existing = this.openDocuments.get(uri);
    if (!existing) return;
    existing.version += 1;
    existing.text = text;
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text }],
    });
    this.notify("textDocument/didSave", { textDocument: { uri }, text });
  }

  private formatWorkspaceEdit(title: string, edit: WorkspaceEdit | undefined): string {
    const { batches, unsupported } = collectWorkspaceTextEdits(edit);
    if (!edit) return `# ${title}\nNo WorkspaceEdit returned.`;

    const lines = [`# ${title}`];
    if (unsupported.length > 0) {
      lines.push("Unsupported parts:", ...unsupported.map((item) => `- ${item}`), "");
    }
    if (batches.length === 0) {
      lines.push("No text edits returned.");
      return lines.join("\n");
    }

    for (const batch of batches) {
      lines.push(`${displayPath(batch.uri, this.root)}: ${batch.edits.length} edit(s)`);
      for (const edit of batch.edits.slice(0, 8)) {
        const preview = edit.newText.replace(/\s+/g, " ").slice(0, 90);
        lines.push(`- ${formatRange(edit.range)} -> ${JSON.stringify(preview)}${edit.newText.length > 90 ? "…" : ""}`);
      }
      if (batch.edits.length > 8) lines.push(`- ... ${batch.edits.length - 8} more edit(s)`);
    }

    return lines.join("\n");
  }

  private formatDiagnostics(uri: string, diagnostics: Diagnostic[]): string {
    const file = displayPath(uri, this.root);
    if (diagnostics.length === 0) return `# Diagnostics: ${file}\nNo diagnostics.`;

    const lines = diagnostics.map((diagnostic, index) => {
      const code = diagnostic.code !== undefined ? ` [${diagnostic.code}]` : "";
      const source = diagnostic.source ? ` (${diagnostic.source})` : "";
      const message = diagnostic.message ?? "<no message>";
      const related = diagnostic.relatedInformation?.length
        ? `\n   Related: ${diagnostic.relatedInformation
            .slice(0, 3)
            .map((info) => {
              const loc = info.location ? `${displayPath(info.location.uri, this.root)}:${formatRange(info.location.range)}` : "";
              return `${loc} ${info.message ?? ""}`.trim();
            })
            .join("; ")}`
        : "";
      return `${index + 1}. ${severityName(diagnostic.severity)}${code}${source} at ${formatRange(diagnostic.range)}\n   ${message}${related}`;
    });

    return [`# Diagnostics: ${file}`, ...lines].join("\n");
  }

  private formatLocations(title: string, value: unknown): string {
    const locations = normalizeLocations(value);
    if (locations.length === 0) return `# ${title}\nNo locations returned.`;

    const lines = locations.map((location, index) => {
      if (isLocationLink(location)) {
        return `${index + 1}. ${displayPath(location.targetUri, this.root)}:${formatRange(location.targetSelectionRange ?? location.targetRange)}`;
      }
      return `${index + 1}. ${displayPath(location.uri, this.root)}:${formatRange(location.range)}`;
    });

    return [`# ${title}`, ...lines].join("\n");
  }

  private formatSymbols(symbols: unknown[], depth = 0): string[] {
    const lines: string[] = [];
    const indent = "  ".repeat(depth);

    for (const symbol of symbols) {
      if (!symbol || typeof symbol !== "object") continue;
      const record = symbol as JsonObject;
      const name = String(record.name ?? "<anonymous>");
      const detail = typeof record.detail === "string" && record.detail.length > 0 ? ` — ${record.detail}` : "";
      const range = record.selectionRange ?? record.range;
      lines.push(`${indent}- ${name}${detail} (${formatRange(range as Range | undefined)})`);
      if (Array.isArray(record.children)) lines.push(...this.formatSymbols(record.children, depth + 1));
    }

    return lines;
  }

  private appendLog(line: string): void {
    const clean = line.trim();
    if (!clean) return;
    this.log.push(clean);
    while (this.log.length > MAX_LOG_LINES) this.log.shift();
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.abortListener?.();
      pending.reject(error);
    }
  }
}

export async function expertAvailable(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const { command } = splitExpertCommandFromEnv();
  const result = await runCommand(command, ["--version"], { cwd, timeoutMs: 5_000, signal });
  if (result.ok) return true;

  // Some Expert builds may not implement --version yet; treat a successful stdio start as the stronger check elsewhere.
  return false;
}

export async function resolveExpertRoot(cwd: string, fileOrDir?: string): Promise<string> {
  const root = await findMixRoot(fileOrDir ?? cwd, cwd);
  return root ?? cwd;
}

export async function getExpertSession(cwd: string, fileOrDir?: string): Promise<ExpertLspSession> {
  const root = await resolveExpertRoot(cwd, fileOrDir);
  const existing = sessions.get(root);
  if (existing) return existing;

  const { command, args } = splitExpertCommandFromEnv();
  const session = new ExpertLspSession(root, command, args);
  sessions.set(root, session);
  return session;
}

export function getExpertSessions(): ExpertSessionStatus[] {
  return [...sessions.values()].map((session) => session.status());
}

export function getExpertDiagnosticCounts(): { errors: number; warnings: number; infos: number; hints: number } {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let hints = 0;
  for (const session of sessions.values()) {
    const counts = session.diagnosticCounts();
    errors += counts.errors;
    warnings += counts.warnings;
    infos += counts.infos;
    hints += counts.hints;
  }
  return { errors, warnings, infos, hints };
}

export async function shutdownExpertSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((session) => session.shutdown().catch(() => undefined)));
}

export function formatExpertStatus(statuses: ExpertSessionStatus[]): string {
  if (statuses.length === 0) return "Expert LSP: no session started yet.";

  return statuses
    .map((status) => {
      const tail = status.log.length ? `\nRecent log:\n${status.log.slice(-8).map((line) => `- ${line}`).join("\n")}` : "";
      return [
        "# Expert LSP session",
        `Root: ${status.root}`,
        `Command: ${status.command} ${status.args.join(" ")}`.trim(),
        `Running: ${status.running ? "yes" : "no"}`,
        `Initialized: ${status.initialized ? "yes" : "no"}`,
        `Open docs: ${status.openDocuments}`,
        `Diagnostic files: ${status.diagnosticFiles}`,
        tail,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
