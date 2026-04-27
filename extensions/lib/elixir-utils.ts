import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  code: number | null;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  ok: boolean;
};

export type RunOptions = {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

export const DEFAULT_SHORT_TIMEOUT_MS = 15_000;
export const DEFAULT_LONG_TIMEOUT_MS = 60_000;

const FORMAT_EXTENSIONS = new Set([".ex", ".exs"]);
const CREDO_EXTENSIONS = new Set([".ex", ".exs"]);
const LSP_EXTENSIONS = new Set([".ex", ".exs", ".heex", ".leex"]);

export function isFormatCandidate(filePath: string): boolean {
  return FORMAT_EXTENSIONS.has(path.extname(filePath));
}

export function isCompileCandidate(filePath: string): boolean {
  return path.extname(filePath) === ".ex";
}

export function isCredoCandidate(filePath: string): boolean {
  return CREDO_EXTENSIONS.has(path.extname(filePath));
}

export function isElixirLikeFile(filePath: string): boolean {
  return LSP_EXTENSIONS.has(path.extname(filePath));
}

export function getToolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.path ?? record.file_path ?? record.filePath;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function resolveFromCwd(fileOrDir: string, cwd: string): string {
  return path.isAbsolute(fileOrDir) ? fileOrDir : path.resolve(cwd, fileOrDir);
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export async function findMixRoot(fileOrDir: string, cwd: string): Promise<string | undefined> {
  let current = resolveFromCwd(fileOrDir, cwd);

  if (!(await isDirectory(current))) {
    current = path.dirname(current);
  }

  while (true) {
    if (await exists(path.join(current, "mix.exs"))) return current;

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function runCommand(command: string, args: string[], options: RunOptions): Promise<CommandResult> {
  const cwd = options.cwd;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LONG_TIMEOUT_MS;
  let timedOut = false;
  let stdout = "";
  let stderr = "";

  return await new Promise<CommandResult>((resolve) => {
    let finished = false;
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
    });

    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve({
        command,
        args,
        cwd,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        output,
        timedOut,
        ok: code === 0 && !timedOut,
      });
    };

    const kill = () => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref?.();
    };

    const onAbort = () => {
      timedOut = true;
      child.kill("SIGTERM");
    };

    const timer = setTimeout(kill, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += stderr ? `\n${error.message}` : error.message;
      finish(127);
    });
    child.on("close", finish);
  });
}

export function runMix(projectRoot: string, args: string[], options: Partial<RunOptions> = {}): Promise<CommandResult> {
  return runCommand("mix", args, { ...options, cwd: projectRoot });
}

export async function credoAvailable(projectRoot: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runMix(projectRoot, ["help", "credo"], {
    cwd: projectRoot,
    timeoutMs: DEFAULT_SHORT_TIMEOUT_MS,
    signal,
  });
  return result.ok;
}

export async function beamProcessHasProjectCwd(projectRoot: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runCommand("lsof", ["-c", "beam.smp", "-a", "-d", "cwd"], {
    cwd: projectRoot,
    timeoutMs: 3_000,
    signal,
  });

  if (!result.ok && result.code === 127) return false;
  return result.output.includes(projectRoot);
}

export function compactOutput(output: string, maxChars = 12_000): string {
  if (output.length <= maxChars) return output;
  return `${output.slice(0, 2_000)}\n\n...[truncated ${output.length - maxChars} chars]...\n\n${output.slice(-10_000)}`;
}

export function commandLine(result: CommandResult): string {
  return [result.command, ...result.args].join(" ");
}

export function formatCommandReport(label: string, result: CommandResult): string {
  const header = result.ok ? `✅ ${label}` : `❌ ${label}`;
  const timeout = result.timedOut ? "\nTimed out." : "";
  const output = compactOutput(result.output || "(no output)");

  return [
    header,
    `Command: ${commandLine(result)}`,
    `CWD: ${result.cwd}`,
    timeout,
    "",
    output,
  ]
    .filter(Boolean)
    .join("\n");
}

export function appendTextContent(content: unknown, text: string): Array<{ type: "text"; text: string }> {
  const appended = `\n\n---\n${text}`;

  if (Array.isArray(content)) {
    return [...content, { type: "text", text: appended }];
  }

  if (typeof content === "string") {
    return [{ type: "text", text: `${content}${appended}` }];
  }

  return [{ type: "text", text }];
}

export function detailsWithPiElixir(details: unknown, key: string, value: unknown): Record<string, unknown> {
  const base = details && typeof details === "object" && !Array.isArray(details) ? details : {};
  return {
    ...base,
    piElixir: {
      ...((base as Record<string, unknown>).piElixir as Record<string, unknown> | undefined),
      [key]: value,
    },
  };
}

export function parseArgs(input: string): string[] {
  // Minimal shell-like splitter for slash-command convenience. Prefer the LLM tool for complex args.
  return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, "")) ?? [];
}
