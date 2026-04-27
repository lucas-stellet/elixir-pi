export type CommandHealth = {
  ok: boolean;
  when: number;
};

export type CompileHealth = CommandHealth & {
  output?: string;
};

export type CredoHealth = CommandHealth & {
  issues?: number;
};

export type TestHealth = CommandHealth & {
  passed?: number;
  failed?: number;
};

export type HealthSnapshot = {
  compile?: CompileHealth;
  credo?: CredoHealth;
  test?: TestHealth;
};

export type LiveInfo = {
  expertConnected: boolean;
  expertErrors: number;
  expertWarnings: number;
  gitBranch?: string;
  elixirVersion?: string;
  otpVersion?: string;
};

let snapshot: HealthSnapshot = {};

export function getHealth(): HealthSnapshot {
  return { ...snapshot };
}

export function setCompileHealth(health: CompileHealth): void {
  snapshot.compile = health;
}

export function setCredoHealth(health: CredoHealth): void {
  snapshot.credo = health;
}

export function setTestHealth(health: TestHealth): void {
  snapshot.test = health;
}

function timeAgo(when: number): string {
  const seconds = Math.floor((Date.now() - when) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function parseTestCounts(output: string): { passed?: number; failed?: number } {
  const testsMatch = output.match(/(\d+)\s+tests?/);
  const failuresMatch = output.match(/(\d+)\s+failures?/);
  return {
    passed: testsMatch ? parseInt(testsMatch[1], 10) : undefined,
    failed: failuresMatch ? parseInt(failuresMatch[1], 10) : undefined,
  };
}

function parseCredoIssues(output: string): number | undefined {
  const match = output.match(/Found\s+(\d+)\s+code issues?/i);
  if (match) return parseInt(match[1], 10);
  if (/no issues found/i.test(output)) return 0;
  return undefined;
}

export function recordCompile(ok: boolean, output?: string): void {
  setCompileHealth({ ok, when: Date.now(), output });
}

export function recordCredo(ok: boolean, output?: string): void {
  setCredoHealth({ ok, when: Date.now(), issues: output ? parseCredoIssues(output) : undefined });
}

export function recordTest(ok: boolean, output?: string): void {
  const parsed = output ? parseTestCounts(output) : {};
  setTestHealth({ ok, when: Date.now(), ...parsed });
}

export function formatHealth(snap: HealthSnapshot, live: LiveInfo): string {
  const lines: string[] = [];

  // Expert
  if (live.expertConnected) {
    lines.push(`🔮 Expert: connected · ${live.expertErrors} errors / ${live.expertWarnings} warnings`);
  } else {
    lines.push("🔮 Expert: not connected");
  }

  // Compile
  if (snap.compile) {
    const icon = snap.compile.ok ? "✅" : "❌";
    lines.push(`⚡ Compile: ${icon} (${timeAgo(snap.compile.when)})`);
  }

  // Credo
  if (snap.credo) {
    const icon = snap.credo.ok ? "✅" : "❌";
    const issues = snap.credo.issues !== undefined ? ` · ${snap.credo.issues} issues` : "";
    lines.push(`🔍 Credo: ${icon} (${timeAgo(snap.credo.when)})${issues}`);
  }

  // Test
  if (snap.test) {
    const icon = snap.test.ok ? "✅" : "❌";
    const parts: string[] = [];
    if (snap.test.passed !== undefined) parts.push(`${snap.test.passed} passed`);
    if (snap.test.failed !== undefined) parts.push(`${snap.test.failed} failed`);
    const stats = parts.length > 0 ? parts.join(" · ") : "ran";
    lines.push(`🧪 Test: ${icon} ${stats} (${timeAgo(snap.test.when)})`);
  }

  // Footer
  const footer: string[] = [];
  if (live.gitBranch) footer.push(live.gitBranch);
  if (live.elixirVersion) footer.push(`Elixir ${live.elixirVersion}`);
  if (live.otpVersion) footer.push(`OTP ${live.otpVersion}`);
  if (footer.length > 0) lines.push(`📂 ${footer.join(" · ")}`);

  return lines.join("\n");
}
