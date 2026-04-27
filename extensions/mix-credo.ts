import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { recordCredo } from "./lib/project-health.ts";
import {
  appendTextContent,
  credoAvailable,
  DEFAULT_LONG_TIMEOUT_MS,
  detailsWithPiElixir,
  findMixRoot,
  formatCommandReport,
  getToolFilePath,
  isCredoCandidate,
  runMix,
} from "./lib/elixir-utils.ts";

const WRITE_TOOLS = new Set(["write", "edit"]);

export default function mixCredoExtension(pi: ExtensionAPI) {
  const credoRoots = new Set<string>();
  const notCredoRoots = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    const projectRoot = await findMixRoot(ctx.cwd, ctx.cwd);
    if (!projectRoot) return;

    if (await credoAvailable(projectRoot)) {
      credoRoots.add(projectRoot);
    } else {
      notCredoRoots.add(projectRoot);
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !WRITE_TOOLS.has(event.toolName)) return undefined;

    const filePath = getToolFilePath(event.input);
    if (!filePath || !isCredoCandidate(filePath)) return undefined;

    const projectRoot = await findMixRoot(filePath, ctx.cwd);
    if (!projectRoot) return undefined;

    if (notCredoRoots.has(projectRoot)) return undefined;

    if (!credoRoots.has(projectRoot)) {
      if (await credoAvailable(projectRoot, ctx.signal)) {
        credoRoots.add(projectRoot);
      } else {
        notCredoRoots.add(projectRoot);
        return undefined;
      }
    }

    ctx.ui.setStatus("elixir-pi", "mix credo");
    const result = await runMix(projectRoot, ["credo"], {
      cwd: projectRoot,
      timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
      signal: ctx.signal,
    });
    ctx.ui.setStatus("elixir-pi", "");

    const report = formatCommandReport("mix credo", result);

    recordCredo(result.ok, result.output);

    if (ctx.hasUI) {
      ctx.ui.notify(result.ok ? "Credo passed" : "mix credo found issues", result.ok ? "info" : "error");
    }

    return {
      content: appendTextContent(event.content, report),
      details: detailsWithPiElixir(event.details, "credo", result),
      isError: event.isError || !result.ok,
    };
  });
}
