import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { compactOutput, parseArgs, resolveFromCwd } from "./lib/elixir-utils.ts";
import {
  formatExpertStatus,
  getExpertSession,
  getExpertSessions,
  shutdownExpertSessions,
} from "./lib/expert-lsp-client.ts";

const ExpertActions = [
  "status",
  "start",
  "restart",
  "shutdown",
  "diagnostics",
  "hover",
  "definition",
  "references",
  "document_symbols",
  "completion",
  "rename",
  "formatting",
] as const;

type ExpertAction = (typeof ExpertActions)[number];

type ExpertParams = {
  action: ExpertAction;
  path?: string;
  line?: number;
  character?: number;
  includeDeclaration?: boolean;
  waitMs?: number;
  newName?: string;
  apply?: boolean;
};

function requirePath(params: ExpertParams): string {
  if (!params.path || params.path.trim().length === 0) {
    throw new Error(`Expert action '${params.action}' requires a file path.`);
  }
  return params.path;
}

function requireNewName(params: ExpertParams): string {
  if (!params.newName || params.newName.trim().length === 0) {
    throw new Error(`Expert action '${params.action}' requires newName.`);
  }
  return params.newName;
}

function requirePosition(params: ExpertParams): void {
  if (
    typeof params.line !== "number" ||
    typeof params.character !== "number" ||
    !Number.isFinite(params.line) ||
    !Number.isFinite(params.character)
  ) {
    throw new Error(`Expert action '${params.action}' requires 1-based line and character numbers.`);
  }
}

async function runExpertAction(params: ExpertParams, cwd: string, signal?: AbortSignal): Promise<string> {
  const normalizedPath = params.path ? resolveFromCwd(params.path, cwd) : undefined;

  if (params.action === "status") return formatExpertStatus(getExpertSessions());

  if (params.action === "shutdown") {
    await shutdownExpertSessions();
    return "Expert LSP sessions shut down.";
  }

  const session = await getExpertSession(cwd, normalizedPath);

  if (params.action === "start") {
    await session.start(signal);
    return formatExpertStatus([session.status()]);
  }

  if (params.action === "restart") {
    await session.restart(signal);
    return formatExpertStatus([session.status()]);
  }

  if (params.action === "diagnostics") {
    return await session.diagnosticsFor(normalizedPath, params.waitMs, signal);
  }

  if (params.action === "hover") {
    requirePath(params);
    requirePosition(params);
    return await session.hover(normalizedPath!, params.line, params.character, signal);
  }

  if (params.action === "definition") {
    requirePath(params);
    requirePosition(params);
    return await session.definition(normalizedPath!, params.line, params.character, signal);
  }

  if (params.action === "references") {
    requirePath(params);
    requirePosition(params);
    return await session.references(normalizedPath!, params.line, params.character, params.includeDeclaration ?? true, signal);
  }

  if (params.action === "document_symbols") {
    requirePath(params);
    return await session.documentSymbols(normalizedPath!, signal);
  }

  if (params.action === "completion") {
    requirePath(params);
    requirePosition(params);
    return await session.completion(normalizedPath!, params.line, params.character, signal);
  }

  if (params.action === "rename") {
    requirePath(params);
    requirePosition(params);
    return await session.rename(normalizedPath!, params.line, params.character, requireNewName(params), params.apply ?? false, signal);
  }

  if (params.action === "formatting") {
    requirePath(params);
    return await session.formatting(normalizedPath!, params.apply ?? false, signal);
  }

  throw new Error(`Unknown Expert action: ${params.action}`);
}

function parseExpertCommand(args: string): ExpertParams {
  const parts = parseArgs(args ?? "");
  const command = (parts.shift() ?? "status") as string;

  if (command === "symbols" || command === "document_symbols") {
    return { action: "document_symbols", path: parts[0] };
  }

  if (command === "diag" || command === "diagnostics") {
    return { action: "diagnostics", path: parts[0] };
  }

  if (command === "status" || command === "start" || command === "restart" || command === "shutdown") {
    return { action: command as ExpertAction };
  }

  if (command === "hover" || command === "definition" || command === "references" || command === "completion") {
    const [filePath, line, character] = parts;
    return {
      action: command as ExpertAction,
      path: filePath,
      line: line ? Number.parseInt(line, 10) : undefined,
      character: character ? Number.parseInt(character, 10) : undefined,
    };
  }

  if (command === "rename") {
    const [filePath, line, character, newName, applyArg] = parts;
    return {
      action: "rename",
      path: filePath,
      line: line ? Number.parseInt(line, 10) : undefined,
      character: character ? Number.parseInt(character, 10) : undefined,
      newName,
      apply: applyArg === "--apply" || applyArg === "apply" || applyArg === "true",
    };
  }

  if (command === "formatting" || command === "format") {
    const [filePath, applyArg] = parts;
    return {
      action: "formatting",
      path: filePath,
      apply: applyArg === "--apply" || applyArg === "apply" || applyArg === "true",
    };
  }

  throw new Error("Usage: /expert status|start|restart|shutdown|diagnostics [file]|hover <file> <line> <character>|definition <file> <line> <character>|references <file> <line> <character>|symbols <file>|completion <file> <line> <character>|rename <file> <line> <character> <newName> [--apply]|format <file> [--apply]");
}

export default function elixirExpertExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "elixir_expert",
    label: "Elixir Expert LSP",
    description: "Use the Expert Elixir language server over LSP for diagnostics, hover, definitions, references, document symbols, completions, rename previews/applies, and formatting previews/applies.",
    promptSnippet: "Use Expert LSP for Elixir code intelligence: diagnostics, hover, definition, references, symbols, completions, and safe text edit previews/applies.",
    promptGuidelines: [
      "Use elixir_expert diagnostics after editing Elixir, HEEx, or LEEx files when you need language-server diagnostics beyond Mix output.",
      "Use elixir_expert definition/references/hover to inspect Elixir code before making invasive changes.",
      "Use elixir_expert rename with apply=false first to preview language-server edits; use apply=true only when the user asked for the rename or you are sure the preview is correct.",
      "Line and character arguments for elixir_expert are 1-based; pass the exact file path and cursor position from the source file.",
    ],
    parameters: Type.Object({
      action: StringEnum(ExpertActions),
      path: Type.Optional(Type.String({ description: "File path for file-specific actions. Required for hover, definition, references, document_symbols, completion, rename, and formatting. Optional for diagnostics." })),
      line: Type.Optional(Type.Number({ description: "1-based line number for hover, definition, references, completion, or rename." })),
      character: Type.Optional(Type.Number({ description: "1-based UTF-16 character offset for hover, definition, references, completion, or rename." })),
      includeDeclaration: Type.Optional(Type.Boolean({ description: "For references, include the declaration location. Defaults to true." })),
      waitMs: Type.Optional(Type.Number({ description: "For diagnostics, milliseconds to wait after syncing the file before reading published diagnostics. Defaults to 900." })),
      newName: Type.Optional(Type.String({ description: "For rename, the new symbol name." })),
      apply: Type.Optional(Type.Boolean({ description: "For rename/formatting, apply Expert's text edits to disk. Defaults to false for preview-only." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Expert LSP: ${params.action}...` }] });
      const text = await runExpertAction(params as ExpertParams, ctx.cwd, signal);
      return {
        content: [{ type: "text", text }],
        details: { action: params.action, path: params.path, line: params.line, character: params.character },
      };
    },
  });

  pi.registerCommand("expert", {
    description: "Expert LSP helper: /expert status|start|restart|diagnostics [file]|hover <file> <line> <character>|definition ...|references ...|symbols <file>|completion ...|rename <file> <line> <character> <newName> [--apply]|format <file> [--apply]",
    getArgumentCompletions: (prefix: string) => {
      const values = ["status", "start", "restart", "shutdown", "diagnostics", "hover", "definition", "references", "symbols", "completion", "rename", "format"];
      const items = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        const params = parseExpertCommand(args ?? "");
        const text = await runExpertAction(params, ctx.cwd, ctx.signal);
        ctx.ui.notify(compactOutput(text, 10_000), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await shutdownExpertSessions();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!(await findMixRoot(ctx.cwd, ctx.cwd))) return undefined;

    const addition = [
      "",
      "Elixir Expert LSP is available through the `elixir_expert` tool.",
      "Prefer it for Elixir language-server questions: diagnostics, hover, definition, references, document symbols, completion candidates, and rename previews.",
      "Use 1-based line and character positions when calling it.",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n${addition}` };
  });
}
