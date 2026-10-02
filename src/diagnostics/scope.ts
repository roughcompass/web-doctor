import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { DiagnosticScope } from "./providers.js";

const execFileAsync = promisify(execFile);

/**
 * The files and lines changed since a base revision, from Git. Git runs with
 * an argument list and no shell; the base is resolved with
 * `--end-of-options`, and the file system monitor, hooks, external diff
 * drivers, and textconv are disabled so no repository-controlled program
 * runs. Untracked files count as changed in full.
 */

const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.noprefix=false"];
const TIMEOUT_MS = 30_000;

export interface ChangedScopeOptions {
  /** The application root. */
  root: string;
  repositoryRoot: string;
  base: string;
  mode: "changed-files" | "changed-lines";
  git?: string;
}

export async function changedScope(options: ChangedScopeOptions): Promise<DiagnosticScope> {
  const git = options.git ?? "git";
  const run = async (args: string[]) => (await execFileAsync(git, [...SAFE_GIT, ...args], { cwd: options.repositoryRoot, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" } })).stdout;
  let commit: string;
  try {
    commit = (await run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${options.base}^{commit}`])).trim();
  } catch {
    throw new Error(`The base revision ${JSON.stringify(options.base)} does not name a commit`);
  }
  const prefix = path.relative(options.repositoryRoot, options.root).split(path.sep).join("/");
  const pathspec = prefix === "" ? "." : prefix;
  const diff = await run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=0", commit, "--", pathspec]);
  const untracked = (await run(["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec])).split("\0").filter(Boolean);

  const lines = new Map<string, [number, number][]>();
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line === "+++ /dev/null" ? null : line.slice(line.startsWith("+++ b/") ? 6 : 4);
      if (current !== null && !lines.has(current)) lines.set(current, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk !== null && current !== null) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) lines.get(current)!.push([start, start + count - 1]);
    }
  }
  for (const file of untracked) lines.set(file, [[1, Number.MAX_SAFE_INTEGER]]);

  const relative = (file: string) => (prefix === "" ? file : file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : null);
  const scoped = new Map<string, [number, number][]>();
  for (const [file, ranges] of lines) {
    const inside = relative(file);
    if (inside !== null) scoped.set(inside, ranges);
  }
  return {
    mode: options.mode,
    files: [...scoped.keys()].sort(),
    lines: options.mode === "changed-lines" ? scoped : new Map(),
    base: commit,
  };
}

/** A changed-file scope for an explicit list of application-relative files. */
export function fileScope(files: readonly string[]): DiagnosticScope {
  return { mode: "changed-files", files: [...new Set(files)].sort(), lines: new Map(), base: null };
}
