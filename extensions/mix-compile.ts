import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { recordCompile } from "./lib/project-health.ts";
import {
  appendTextContent,
  beamProcessHasProjectCwd,
  DEFAULT_LONG_TIMEOUT_MS,
  detailsWithPiElixir,
  findMixRoot,
  formatCommandReport,
  getToolFilePath,
  isCompileCandidate,
  runMix,
} from "./lib/elixir-utils.ts";

const WRITE_TOOLS = new Set(["write", "edit"]);

export default function mixCompileExtension(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !WRITE_TOOLS.has(event.toolName)) return undefined;

    const filePath = getToolFilePath(event.input);
    if (!filePath || !isCompileCandidate(filePath)) return undefined;

    const projectRoot = await findMixRoot(filePath, ctx.cwd);
    if (!projectRoot) return undefined;

    if (await beamProcessHasProjectCwd(projectRoot, ctx.signal)) {
      const report = `⏭️ mix compile skipped\nA BEAM process has this project as cwd, so compiling now can hang on the build lock. Run /elixir compile manually after stopping the running server/IEx session.`;
      return {
        content: appendTextContent(event.content, report),
        details: detailsWithPiElixir(event.details, "compile", { skipped: true, reason: "beam-process-running", projectRoot }),
      };
    }

    ctx.ui.setStatus("elixir-pi", "mix compile");
    const result = await runMix(projectRoot, ["compile", "--warnings-as-errors"], {
      cwd: projectRoot,
      timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
      signal: ctx.signal,
    });
    ctx.ui.setStatus("elixir-pi", "");

    const report = formatCommandReport("mix compile --warnings-as-errors", result);

    recordCompile(result.ok, result.output);

    if (ctx.hasUI) {
      ctx.ui.notify(result.ok ? "Compiled successfully" : "mix compile failed", result.ok ? "info" : "error");
    }

    return {
      content: appendTextContent(event.content, report),
      details: detailsWithPiElixir(event.details, "compile", result),
      isError: event.isError || !result.ok,
    };
  });
}
