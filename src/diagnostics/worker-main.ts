import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * The entry point of a bounded provider worker. It reads one task from
 * stdin, runs the named export of the task module, and writes one JSON result
 * to file descriptor 3, so output the task prints cannot corrupt the result.
 */

interface TaskRequest {
  module: string;
  export: string;
  input: unknown;
  scratch: string | null;
}

export interface TaskEnvironment {
  /** The only directory the task may write, when it was granted one. */
  scratch: string | null;
}

const denied: string[] = ((globalThis as { __webDoctorDenied?: string[] }).__webDoctorDenied ??= []);

const CAPABILITIES: Readonly<Record<string, string>> = {
  FileSystemRead: "filesystem-read",
  FileSystemWrite: "filesystem-write",
  ChildProcess: "process-spawn",
  WorkerThreads: "worker-threads",
  Addon: "addons",
  WASI: "wasi",
  Network: "network",
};

function send(message: unknown): void {
  fs.writeSync(3, `${JSON.stringify(message)}\n`);
}

function deniedCapability(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current !== null && typeof current === "object" && depth < 5; current = (current as { cause?: unknown }).cause, depth++) {
    const { code, permission } = current as { code?: unknown; permission?: unknown };
    if ((code === "ERR_ACCESS_DENIED" || code === "ERR_WEB_DOCTOR_NETWORK_DENIED") && typeof permission === "string") return CAPABILITIES[permission] ?? permission;
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const request = JSON.parse(await readStdin()) as TaskRequest;
  const loaded = await import(pathToFileURL(request.module).href) as Record<string, unknown>;
  const task = loaded[request.export];
  if (typeof task !== "function") throw new Error(`${request.export} is not a task in ${request.module}`);
  const output = await (task as (input: unknown, environment: TaskEnvironment) => unknown)(request.input, { scratch: request.scratch });
  send({ ok: true, output, denied: [...new Set(denied)].sort() });
}

main().catch((error: unknown) => {
  const capability = deniedCapability(error);
  if (capability !== undefined) denied.push(capability);
  const { code, message } = error as { code?: unknown; message?: unknown };
  send({ ok: false, error: { code: typeof code === "string" ? code : null, message: typeof message === "string" ? message : String(error), capability: capability ?? null }, denied: [...new Set(denied)].sort() });
  process.exitCode = 1;
});
