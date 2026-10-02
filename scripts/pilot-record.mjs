#!/usr/bin/env node
// Records one advisory pilot run: runs a Web Doctor command with --json,
// measures how long it took, and saves the response with the elapsed time.
// Web Doctor itself is unchanged; this only observes it.
//
// Usage: node scripts/pilot-record.mjs --pilot <dir> [--app <name>] -- <web-doctor arguments...>

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator === -1) throw new Error("Usage: node scripts/pilot-record.mjs --pilot <dir> [--app <name>] -- <web-doctor arguments...>");
const own = argv.slice(0, separator);
const command = argv.slice(separator + 1);
const option = (name) => (own.includes(name) ? own[own.indexOf(name) + 1] : undefined);
const pilot = option("--pilot");
if (pilot === undefined || command.length === 0) throw new Error("Pass --pilot <dir> and the Web Doctor arguments after --");
const app = option("--app") ?? path.basename(process.cwd());
const bin = process.env.WEB_DOCTOR_BIN ?? "web-doctor";

const args = command.includes("--json") ? command : [...command, "--json"];
const started = performance.now();
let stdout = "";
let exitCode = 0;
try {
  ({ stdout } = await execFileAsync(bin, args, { maxBuffer: 256 * 1024 * 1024, env: process.env }));
} catch (error) {
  stdout = error.stdout ?? "";
  exitCode = typeof error.code === "number" ? error.code : 1;
}
const elapsedMs = Math.round(performance.now() - started);
let response = null;
try {
  response = JSON.parse(stdout);
} catch {
  response = null;
}
const record = { schema: "web-doctor.pilot-record", schemaVersion: 1, recordedAt: new Date().toISOString(), app, command: args, exitCode, elapsedMs, response };
const directory = path.join(pilot, "records");
await fs.mkdir(directory, { recursive: true });
const name = `${record.recordedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`;
await fs.writeFile(path.join(directory, name), `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(stdout);
process.stderr.write(`pilot: recorded ${args.join(" ")} for ${app} in ${elapsedMs} ms (exit ${exitCode})\n`);
process.exitCode = exitCode;
