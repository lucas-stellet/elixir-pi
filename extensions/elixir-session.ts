import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { exists } from "./lib/elixir-utils.ts";

async function isElixirProject(cwd: string): Promise<boolean> {
  return await exists(path.join(cwd, "mix.exs"));
}

export default function elixirSessionExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!(await isElixirProject(ctx.cwd))) return;

  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!(await isElixirProject(ctx.cwd))) return undefined;

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\nElixir project guidance from pi-elixir:\n` +
        `- Prefer changing the smallest useful surface area.\n` +
        `- After editing .ex files, validate with elixir_mix action=compile when safe.\n` +
        `- After editing .ex/.exs files, validate with elixir_mix action=format and action=credo when relevant.\n` +
        `- For architecture questions, consider loading /skill:elixir-thinking, /skill:phoenix-thinking, /skill:ecto-thinking, or /skill:otp-thinking.`,
    };
  });
}
