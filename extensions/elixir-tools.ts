import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { getExpertDiagnosticCounts, getExpertSessions } from "./lib/expert-lsp-client.ts";
import { formatHealth, getHealth, recordCompile, recordCredo, recordTest } from "./lib/project-health.ts";
import {
  beamProcessHasProjectCwd,
  commandLine,
  compactOutput,
  credoAvailable,
  DEFAULT_LONG_TIMEOUT_MS,
  DEFAULT_SHORT_TIMEOUT_MS,
  exists,
  findMixRoot,
  formatCommandReport,
  parseArgs,
  resolveFromCwd,
  runCommand,
  runMix,
} from "./lib/elixir-utils.ts";

const Actions = ["doctor", "format", "compile", "credo", "test", "status"] as const;
type Action = (typeof Actions)[number];

type ElixirMixParams = {
  action: Action;
  path?: string;
  args?: string[];
};

async function findProjectRootForCommand(cwd: string, pathArg?: string): Promise<string | undefined> {
  return await findMixRoot(pathArg ?? cwd, cwd);
}

async function runAction(params: ElixirMixParams, cwd: string, signal?: AbortSignal): Promise<string> {
  const projectRoot = await findProjectRootForCommand(cwd, params.path);

  if (params.action === "doctor") {
    const mixVersion = await runCommand("mix", ["--version"], { cwd, timeoutMs: DEFAULT_SHORT_TIMEOUT_MS, signal });
    const expertVersion = await runCommand("expert", ["--version"], { cwd, timeoutMs: DEFAULT_SHORT_TIMEOUT_MS, signal });
    const rootLine = projectRoot ? `Mix project: ${projectRoot}` : "Mix project: not found from current directory";
    return [
      "# Elixir doctor",
      rootLine,
      "",
      mixVersion.ok ? `✅ mix found: ${compactOutput(mixVersion.output, 2_000)}` : `❌ mix not available: ${compactOutput(mixVersion.output, 2_000)}`,
      expertVersion.ok ? `✅ expert found: ${compactOutput(expertVersion.output, 2_000)}` : "⚠️ expert not found on PATH. Install it only if you want Expert LSP integration.",
      projectRoot && (await credoAvailable(projectRoot, signal)) ? "✅ credo task available" : "⚠️ credo task not available or no mix project found",
    ].join("\n");
  }

  if (!projectRoot) {
    throw new Error("No mix.exs found. Run this from an Elixir Mix project or pass a file path inside one.");
  }

  if (params.action === "format") {
    const args = ["format", ...(params.path ? [resolveFromCwd(params.path, cwd)] : []), ...(params.args ?? [])];
    const result = await runMix(projectRoot, args, { cwd: projectRoot, timeoutMs: DEFAULT_SHORT_TIMEOUT_MS, signal });
    const report = formatCommandReport(commandLine(result), result);
    if (!result.ok) throw new Error(report);
    return report;
  }

  if (params.action === "compile") {
    if (await beamProcessHasProjectCwd(projectRoot, signal)) {
      return "⏭️ mix compile skipped: a BEAM process has this project as cwd, so compiling now can hang on the build lock. Stop the running server/IEx session and retry.";
    }
    const result = await runMix(projectRoot, ["compile", "--warnings-as-errors", ...(params.args ?? [])], {
      cwd: projectRoot,
      timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
      signal,
    });
    recordCompile(result.ok, result.output);
    const report = formatCommandReport("mix compile --warnings-as-errors", result);
    if (!result.ok) throw new Error(report);
    return report;
  }

  if (params.action === "credo") {
    if (!(await credoAvailable(projectRoot, signal))) {
      return "⏭️ mix credo skipped: Credo task is not installed in this Mix project.";
    }
    const result = await runMix(projectRoot, ["credo", ...(params.args ?? [])], {
      cwd: projectRoot,
      timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
      signal,
    });
    recordCredo(result.ok, result.output);
    const report = formatCommandReport("mix credo", result);
    if (!result.ok) throw new Error(report);
    return report;
  }

  if (params.action === "test") {
    const result = await runMix(projectRoot, ["test", ...(params.args ?? [])], {
      cwd: projectRoot,
      timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
      signal,
    });
    recordTest(result.ok, result.output);
    const report = formatCommandReport(`mix test ${(params.args ?? []).join(" ")}`.trim(), result);
    if (!result.ok) throw new Error(report);
    return report;
  }

  if (params.action === "status") {
    const sessions = getExpertSessions();
    const connected = sessions.some((s) => s.initialized && s.running);
    const counts = getExpertDiagnosticCounts();
    return formatHealth(getHealth(), {
      expertConnected: connected,
      expertErrors: counts.errors,
      expertWarnings: counts.warnings,
    });
  }

  throw new Error(`Unknown action: ${params.action}`);
}

export default function elixirToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "elixir_mix",
    label: "Elixir Mix",
    description: "Run common Elixir Mix project checks from the nearest mix.exs: doctor, format, compile --warnings-as-errors, credo, test, or project health status.",
    promptSnippet: "Run Elixir Mix validation tasks from the nearest mix.exs: doctor, format, compile, credo, test, or status.",
    promptGuidelines: [
      "Use elixir_mix after editing Elixir code to run the smallest relevant Mix validation task before claiming success.",
      "Use elixir_mix with action=compile after changes to .ex files unless a running BEAM process makes compilation unsafe.",
      "Use elixir_mix with action=credo for Elixir code quality checks when Credo is installed.",
    ],
    parameters: Type.Object({
      action: StringEnum(Actions),
      path: Type.Optional(Type.String({ description: "Optional file or directory used to find the nearest mix.exs. For format, this can be the file to format." })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments passed to mix for format/compile/credo/test." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Running elixir_mix ${params.action}...` }] });
      const text = await runAction(params as ElixirMixParams, ctx.cwd, signal);
      return {
        content: [{ type: "text", text }],
        details: { action: params.action, path: params.path, args: params.args },
      };
    },
  });

  pi.registerCommand("elixir", {
    description: "Elixir helper: /elixir doctor|format [file]|compile|credo|test [args...]|status",
    getArgumentCompletions: (prefix: string) => {
      const items = ["doctor", "format", "compile", "credo", "test", "status"].map((value) => ({ value, label: value }));
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parts = parseArgs(args ?? "");
      const action = (parts.shift() ?? "doctor") as Action;

      if (!Actions.includes(action)) {
        ctx.ui.notify("Usage: /elixir doctor|format [file]|compile|credo|test [args...]|status", "warning");
        return;
      }

      const path = action === "format" && parts[0] && (await exists(resolveFromCwd(parts[0], ctx.cwd))) ? parts.shift() : undefined;

      try {
        const text = await runAction({ action, path, args: parts }, ctx.cwd, ctx.signal);
        ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
