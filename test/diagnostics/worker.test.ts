import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWorker, type WorkerGrant, type WorkerLimits } from "../../src/diagnostics/worker.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/workers");
const TASKS = path.join(FIXTURES, "tasks.mjs");
const GRANT: WorkerGrant = { read: [FIXTURES], network: false };
const LIMITS: WorkerLimits = { timeoutMs: 10_000, memoryMb: 128, outputBytes: 1_000_000 };
let outside: string;

beforeAll(async () => {
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-outside-")));
  await fs.writeFile(path.join(outside, "secret.txt"), "do-not-leak");
});

afterAll(async () => {
  await fs.rm(outside, { recursive: true, force: true });
});

const run = (name: string, input: unknown = null, limits: WorkerLimits = LIMITS, grant: WorkerGrant = GRANT) => runWorker({ module: TASKS, export: name, input }, grant, limits);

describe("bounded provider worker", () => {
  it("returns a task's result on a channel that printed output cannot corrupt", async () => {
    expect(await run("echo", { files: 3 })).toMatchObject({ status: "ok", output: { received: { files: 3 } }, denied: [] });
    expect(await run("noisy")).toMatchObject({ status: "ok", output: { quiet: true } });
  });

  it("isolates and reports crashes, failures, hangs, oversized output, and memory exhaustion", async () => {
    expect(await run("exit")).toMatchObject({ status: "crashed", detail: "The provider exited without a result (exit code 3)" });
    expect(await run("fail")).toMatchObject({ status: "failed", detail: "the provider failed on purpose" });
    const hang = await run("hang", null, { ...LIMITS, timeoutMs: 1_000 });
    expect(hang).toMatchObject({ status: "timeout", detail: "The provider did not finish within 1000 ms" });
    expect(hang.durationMs).toBeLessThan(5_000);
    expect(await run("large")).toMatchObject({ status: "output_exceeded", detail: "The provider produced more than 1000000 bytes of output" });
    expect(await run("exhaust", null, { ...LIMITS, memoryMb: 64 })).toMatchObject({ status: "crashed", detail: "The provider exceeded its 64 MB memory limit" });
  }, 60_000);

  it("denies processes, writes, reads outside the grant, and undeclared network access", async () => {
    expect(await run("spawnProcess")).toMatchObject({ status: "denied", denied: ["process-spawn"] });
    expect(await run("writeFile", { path: path.join(FIXTURES, "written.txt") })).toMatchObject({ status: "denied", denied: ["filesystem-write"] });
    await expect(fs.access(path.join(FIXTURES, "written.txt"))).rejects.toThrow();
    const read = await run("readOutside", { path: path.join(outside, "secret.txt") });
    expect(read).toMatchObject({ status: "denied", denied: ["filesystem-read"] });
    expect(JSON.stringify(read)).not.toContain("do-not-leak");
    expect(await run("connect")).toMatchObject({ status: "denied", denied: ["network"] });
    expect(await run("fetchSwallowed")).toMatchObject({ status: "ok", output: "continued", denied: ["network"] });
  }, 60_000);

  it("allows writes only inside a granted scratch directory, which is removed afterwards", async () => {
    const scratch = await run("scratchOnly", null, LIMITS, { ...GRANT, scratch: true });
    expect(scratch.status).toBe("ok");
    await expect(fs.access((scratch as { output: string }).output)).rejects.toThrow();
    expect(await run("writeScratch", { path: path.join(FIXTURES, "outside.txt") }, LIMITS, { ...GRANT, scratch: true })).toMatchObject({ status: "denied", denied: ["filesystem-write"] });
    await expect(fs.access(path.join(FIXTURES, "outside.txt"))).rejects.toThrow();
  });

  it("allows network access only when the provider declares it", async () => {
    const granted = await run("fetchSwallowed", null, LIMITS, { ...GRANT, network: true });
    expect(granted).toMatchObject({ status: "ok", denied: [] });
  });
});
