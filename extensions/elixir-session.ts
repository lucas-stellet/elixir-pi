import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { getExpertDiagnosticCounts, getExpertSessions } from "./lib/expert-lsp-client.ts";
import { formatHealth, getHealth, type LiveInfo } from "./lib/project-health.ts";
import { exists, runCommand } from "./lib/elixir-utils.ts";

async function isElixirProject(cwd: string): Promise<boolean> {
  return await exists(path.join(cwd, "mix.exs"));
}

function parseElixirVersion(stdout: string): { elixir?: string; otp?: string } {
  const elixirMatch = stdout.match(/Elixir\s+(\d+\.\d+\.\d+)/);
  const otpMatch = stdout.match(/Erlang\/OTP\s+(\d+)/);
  return {
    elixir: elixirMatch?.[1],
    otp: otpMatch?.[1],
  };
}

export default function elixirSessionExtension(pi: ExtensionAPI) {
  let gitBranch: string | undefined;
  let elixirVersion: string | undefined;
  let otpVersion: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (!(await isElixirProject(ctx.cwd))) return;

    ctx.ui.setStatus("elixir-pi", "ctrl+shift+e project status");

    // Cache git branch
    const gitResult = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd }).catch(() => undefined);
    if (gitResult && gitResult.code === 0 && gitResult.stdout.trim()) {
      gitBranch = gitResult.stdout.trim();
    }

    // Cache Elixir/OTP version
    const elixirResult = await runCommand("elixir", ["--version"], { cwd: ctx.cwd }).catch(() => undefined);
    if (elixirResult?.ok) {
      const parsed = parseElixirVersion(elixirResult.stdout);
      elixirVersion = parsed.elixir;
      otpVersion = parsed.otp;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!(await isElixirProject(ctx.cwd))) return undefined;

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\nElixir project guidance from elixir-pi:\n` +
        `- Prefer changing the smallest useful surface area.\n` +
        `- After editing .ex files, validate with elixir_mix action=compile when safe.\n` +
        `- After editing .ex/.exs files, validate with elixir_mix action=format and action=credo when relevant.\n` +
        `- For architecture questions, consider loading /skill:elixir-thinking, /skill:phoenix-thinking, /skill:ecto-thinking, or /skill:otp-thinking.`,
    };
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Show Elixir project health status",
    handler: async (ctx) => {
      if (!(await isElixirProject(ctx.cwd))) {
        ctx.ui.notify("Not an Elixir project.", "warning");
        return;
      }

      const sessions = getExpertSessions();
      const connected = sessions.some((s) => s.initialized && s.running);
      const counts = getExpertDiagnosticCounts();

      const live: LiveInfo = {
        expertConnected: connected,
        expertErrors: counts.errors,
        expertWarnings: counts.warnings,
        gitBranch,
        elixirVersion,
        otpVersion,
      };

      ctx.ui.notify(formatHealth(getHealth(), live), "info");
    },
  });
}
