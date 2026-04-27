import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  appendTextContent,
  DEFAULT_SHORT_TIMEOUT_MS,
  detailsWithPiElixir,
  exists,
  findMixRoot,
  formatCommandReport,
  getToolFilePath,
  isFormatCandidate,
  resolveFromCwd,
  runMix,
} from "./lib/elixir-utils.ts";

const WRITE_TOOLS = new Set(["write", "edit"]);

export default function mixFormatExtension(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !WRITE_TOOLS.has(event.toolName)) return undefined;

    const filePath = getToolFilePath(event.input);
    if (!filePath || !isFormatCandidate(filePath)) return undefined;

    const projectRoot = await findMixRoot(filePath, ctx.cwd);
    if (!projectRoot) return undefined;

    const absolutePath = resolveFromCwd(filePath, ctx.cwd);
    if (!(await exists(absolutePath))) return undefined;

    ctx.ui.setStatus("elixir-pi", "mix format");
    const result = await runMix(projectRoot, ["format", absolutePath], {
      cwd: projectRoot,
      timeoutMs: DEFAULT_SHORT_TIMEOUT_MS,
      signal: ctx.signal,
    });
    ctx.ui.setStatus("elixir-pi", "");

    const report = formatCommandReport(`mix format ${filePath}`, result);

    if (ctx.hasUI) {
      ctx.ui.notify(result.ok ? `Formatted ${filePath}` : `mix format failed for ${filePath}`, result.ok ? "info" : "error");
    }

    return {
      content: appendTextContent(event.content, report),
      details: detailsWithPiElixir(event.details, "format", result),
      isError: event.isError || !result.ok,
    };
  });
}
