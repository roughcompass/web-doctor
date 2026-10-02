import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Runs one provider task in a separate Node process with bounded time,
 * memory, and output, under Node's permission model: filesystem reads only
 * where granted, no writes, no child processes, workers, or addons, and no
 * network unless the provider declared it. A crash, hang, oversized result,
 * or denied capability is reported as an outcome and never escapes.
 */

export interface WorkerLimits {
  timeoutMs: number;
  memoryMb: number;
  outputBytes: number;
}

export const DEFAULT_WORKER_LIMITS: WorkerLimits = { timeoutMs: 120_000, memoryMb: 2_048, outputBytes: 32 * 1024 * 1024 };

export interface WorkerGrant {
  /** Paths the task may read, in addition to Web Doctor itself. */
  read: readonly string[];
  network: boolean;
  /** A private, initially empty directory the task may write, removed after the run. */
  scratch?: boolean;
  /** Whether the task may start processes, such as a browser. */
  processSpawn?: boolean;
  /** Environment variables the task receives; nothing else is inherited. */
  env?: Readonly<Record<string, string>>;
}

export interface WorkerTask {
  /** Absolute path of a compiled task module. */
  module: string;
  export: string;
  input: unknown;
}

export type WorkerOutcome =
  | { status: "ok"; output: unknown; denied: string[]; durationMs: number }
  | { status: "timeout" | "crashed" | "output_exceeded" | "denied" | "failed" | "invalid_output"; detail: string; denied: string[]; durationMs: number };

const LOG_TAIL = 4_096;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The compiled path of a Web Doctor module, whether this code runs from source or from the build. */
export function compiledModule(relative: string): string {
  return path.join(PACKAGE_ROOT, "dist", ...relative.split("/"));
}

export async function runWorker(task: WorkerTask, grant: WorkerGrant, limits: WorkerLimits = DEFAULT_WORKER_LIMITS): Promise<WorkerOutcome> {
  const scratch = grant.scratch === true ? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-provider-"))) : null;
  try {
    return await execute(task, grant, limits, scratch);
  } finally {
    if (scratch !== null) await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Node's permission flags for a grant: reads, scratch and exact writes, processes, workers, addons, memory, and the network guard. */
async function permissionArgs(grant: ScriptGrant, limits: WorkerLimits, scratch: string | null): Promise<string[]> {
  const reads = await grantedReads(grant);
  const writes = [...new Set(await Promise.all((grant.write ?? []).map(realpathOrSelf)))].sort();
  return [
    "--permission",
    ...reads.map((read) => `--allow-fs-read=${read}`),
    ...(scratch === null ? [] : [`--allow-fs-read=${scratch}`, `--allow-fs-write=${scratch}`]),
    ...writes.map((write) => `--allow-fs-write=${write}`),
    ...(grant.processSpawn === true ? ["--allow-child-process"] : []),
    ...(grant.workerThreads === true ? ["--allow-worker"] : []),
    ...(grant.addons === true ? ["--allow-addons"] : []),
    `--max-old-space-size=${limits.memoryMb}`,
    ...preloads(grant).map((url) => `--import=${url}`),
  ];
}

/** The guard modules a grant preloads: the network guard unless network is granted, and read confinement when asked. */
function preloads(grant: ScriptGrant): string[] {
  return [
    ...(grant.network ? [] : [pathToFileURL(compiledModule("diagnostics/network-guard.js")).href]),
    ...(grant.confineReads === true ? [pathToFileURL(compiledModule("diagnostics/read-confinement.js")).href] : []),
  ];
}

async function grantedReads(grant: WorkerGrant): Promise<string[]> {
  return [...new Set(await Promise.all([PACKAGE_ROOT, ...grant.read].map(realpathOrSelf)))].sort();
}

async function execute(task: WorkerTask, grant: WorkerGrant, limits: WorkerLimits, scratch: string | null): Promise<WorkerOutcome> {
  const started = performance.now();
  const args = [...await permissionArgs(grant, limits, scratch), compiledModule("diagnostics/worker-main.js")];
  const env = { ...(grant.env ?? {}), ...(scratch === null ? {} : { TMPDIR: scratch }) };
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe", "pipe"], env, windowsHide: true });
  const result: Buffer[] = [];
  let resultBytes = 0;
  let stderr = "";
  let memoryExhausted = false;
  let stopped: "timeout" | "output_exceeded" | undefined;
  const stop = (reason: typeof stopped) => {
    if (stopped !== undefined) return;
    stopped = reason;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
  const resultStream = child.stdio[3];
  resultStream?.on("data", (chunk: Buffer) => {
    resultBytes += chunk.length;
    if (resultBytes > limits.outputBytes) stop("output_exceeded");
    else result.push(chunk);
  });
  resultStream?.on("error", () => undefined);
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (chunk: Buffer) => {
    // Checked on the whole stream: a native stack trace can push the message out of the kept tail.
    stderr = `${stderr}${chunk.toString("utf8")}`;
    if (/heap out of memory|Allocation failed/i.test(stderr)) memoryExhausted = true;
    stderr = stderr.slice(-LOG_TAIL);
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(JSON.stringify({ ...task, scratch }));

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    child.on("error", () => resolve([null, null]));
  });
  clearTimeout(timer);
  const durationMs = Math.round(performance.now() - started);
  if (stopped === "timeout") return { status: "timeout", detail: `The provider did not finish within ${limits.timeoutMs} ms`, denied: [], durationMs };
  if (stopped === "output_exceeded") return { status: "output_exceeded", detail: `The provider produced more than ${limits.outputBytes} bytes of output`, denied: [], durationMs };

  const line = Buffer.concat(result).toString("utf8").split("\n")[0] ?? "";
  if (line === "") {
    return { status: "crashed", detail: memoryExhausted ?`The provider exceeded its ${limits.memoryMb} MB memory limit` : `The provider exited without a result (${signal ?? `exit code ${code}`})${stderr === "" ? "" : `: ${lastLine(stderr)}`}`, denied: [], durationMs };
  }
  let message: { ok?: unknown; output?: unknown; denied?: unknown; error?: { message?: unknown; capability?: unknown } };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return { status: "invalid_output", detail: "The provider result is not valid JSON", denied: [], durationMs };
  }
  const denied = Array.isArray(message.denied) ? message.denied.filter((entry): entry is string => typeof entry === "string") : [];
  if (message.ok === true) return { status: "ok", output: message.output, denied, durationMs };
  const detail = typeof message.error?.message === "string" ? message.error.message : "The provider failed";
  return typeof message.error?.capability === "string"
    ? { status: "denied", detail: `The provider requested ${message.error.capability} access, which it was not granted: ${detail}`, denied, durationMs }
    : { status: "failed", detail, denied, durationMs };
}

/** A grant for a provider's own Node program, which may also need exact write paths, worker threads, or native addons. */
export interface ScriptGrant extends WorkerGrant {
  /** Exact paths the program may write, beyond its scratch directory. */
  write?: readonly string[];
  workerThreads?: boolean;
  addons?: boolean;
  /** Present reads outside the grant as missing paths, so the program sees only the application. */
  confineReads?: boolean;
}

export interface BoundedScript {
  /** Absolute path of the Node program to run. */
  script: string;
  /** Arguments; `<scratch>` stands for the private scratch directory, here and in the grant's environment. */
  args: readonly string[];
  cwd: string;
}

export const SCRATCH_PLACEHOLDER = "<scratch>";

export interface ScriptRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The private directory the program could write, still present until collection returns. */
  scratch: string | null;
}

export type ScriptOutcome<Result> =
  | { status: "ok"; result: Result; denied: string[]; durationMs: number }
  | { status: "timeout" | "crashed" | "output_exceeded" | "denied" | "failed"; detail: string; denied: string[]; durationMs: number };

const DENIAL_MARKER = "web-doctor-denied:";
const PERMISSIONS: Readonly<Record<string, string>> = { FileSystemRead: "filesystem-read", FileSystemWrite: "filesystem-write", ChildProcess: "process-spawn", WorkerThreads: "worker-threads", Addon: "addons", WASI: "wasi", Network: "network" };

/**
 * Runs a provider's own Node program, such as a CLI, under the same bounds as
 * a worker task. Its arguments and environment are exactly those given; its
 * result is collected from its output and scratch directory before the
 * scratch directory is removed. Network attempts are recorded even when the
 * program swallows the refusal.
 */
export async function runBoundedScript<Result>(script: BoundedScript, grant: ScriptGrant, limits: WorkerLimits, collect: (run: ScriptRun) => Promise<Result>): Promise<ScriptOutcome<Result>> {
  const scratch = grant.scratch === true ? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-provider-"))) : null;
  const started = performance.now();
  try {
    const fill = (value: string) => (scratch === null ? value : value.replaceAll(SCRATCH_PLACEHOLDER, scratch));
    const args = [...await permissionArgs(grant, limits, scratch), script.script, ...script.args.map(fill)];
    const env = {
      ...Object.fromEntries(Object.entries(grant.env ?? {}).map(([name, value]) => [name, fill(value)])),
      ...(scratch === null ? {} : { TMPDIR: scratch }),
      ...(grant.confineReads === true ? { WEB_DOCTOR_READ_ROOTS: JSON.stringify([...await grantedReads(grant), ...(scratch === null ? [] : [scratch])]) } : {}),
      // Child Node processes inherit the permission flags but not preloads, so the guards travel in NODE_OPTIONS too.
      NODE_OPTIONS: preloads(grant).map((url) => `--import=${url}`).join(" "),
      WEB_DOCTOR_DENIAL_LOG: "stderr",
    };
    const child = spawn(process.execPath, args, { cwd: script.cwd, stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    const denied = new Set<string>();
    let memoryExhausted = false;
    let stopped: "timeout" | "output_exceeded" | undefined;
    const stop = (reason: typeof stopped) => {
      if (stopped !== undefined) return;
      stopped = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.outputBytes) stop("output_exceeded");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) if (line.startsWith(DENIAL_MARKER)) denied.add(line.slice(DENIAL_MARKER.length).trim().split(" ")[0]!);
      for (const match of text.matchAll(/permission: '([A-Za-z]+)'/g)) denied.add(PERMISSIONS[match[1]!] ?? match[1]!);
      // Node's own warnings, such as the permission-model notices, are not the program's diagnostics.
      stderr = `${stderr}${text.split("\n").filter((line) => !/^\(node:\d+\) \w*Warning:|^\(Use `node --trace-warnings/.test(line)).join("\n")}`;
      if (/heap out of memory|Allocation failed/i.test(stderr)) memoryExhausted = true;
      stderr = stderr.slice(-LOG_TAIL);
    });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.on("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      child.on("error", () => resolve([null, null]));
    });
    clearTimeout(timer);
    const durationMs = () => Math.round(performance.now() - started);
    const deniedList = () => [...denied].sort();
    if (stopped === "timeout") return { status: "timeout", detail: `The provider did not finish within ${limits.timeoutMs} ms`, denied: deniedList(), durationMs: durationMs() };
    if (stopped === "output_exceeded") return { status: "output_exceeded", detail: `The provider produced more than ${limits.outputBytes} bytes of output`, denied: deniedList(), durationMs: durationMs() };
    if (code === null) return { status: "crashed", detail: memoryExhausted ? `The provider exceeded its ${limits.memoryMb} MB memory limit` : `The provider was stopped (${signal ?? "no exit code"})`, denied: deniedList(), durationMs: durationMs() };
    try {
      const result = await collect({ exitCode: code, stdout: Buffer.concat(stdout).toString("utf8"), stderr, scratch });
      return { status: "ok", result, denied: deniedList(), durationMs: durationMs() };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { status: denied.size > 0 && code !== 0 ? "denied" : "failed", detail: memoryExhausted ? `The provider exceeded its ${limits.memoryMb} MB memory limit` : detail, denied: deniedList(), durationMs: durationMs() };
    }
  } finally {
    if (scratch !== null) await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter((line) => line.trim() !== "").at(-1)?.trim() ?? "";
}
