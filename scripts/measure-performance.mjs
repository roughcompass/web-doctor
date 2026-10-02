#!/usr/bin/env node
// Measures Web Doctor's budgeted operations against fleet repositories and
// checks them against performance/budgets.json. Every measurement uses the
// package at --package, its embedded registry at --registry, and read-only
// repositories; incremental queries run on a temporary copy.
//
// Usage: node scripts/measure-performance.mjs --package <dir> --registry <dir> [--runs <n>] [--out <file>] [--check] <fleet-root>

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = { package: repository, registry: null, runs: 3, out: null, check: false, fleet: null };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
  const value = argv[index];
  if (value === "--package" || value === "--registry" || value === "--out") options[value.slice(2)] = path.resolve(argv[++index]);
  else if (value === "--runs") options.runs = Number(argv[++index]);
  else if (value === "--check") options.check = true;
  else options.fleet = path.resolve(value);
}
if (options.fleet === null || options.registry === null) throw new Error("Usage: node scripts/measure-performance.mjs --package <dir> --registry <dir> [--runs <n>] [--out <file>] [--check] <fleet-root>");

const load = (relative) => import(path.join(options.package, "dist", relative));
const { WorkingTreeListing } = await load("facts/working-tree-reader.js");
const { SharedFactsAnalyzer } = await load("facts/shared-facts.js");
const { buildProjectIndex } = await load("facts/project-index.js");
const { loadEmbeddedRegistry } = await load("runtime/embedded-registry.js");
const { WebDoctor } = await load("core/web-doctor.js");
const { createWebDoctorServer } = await load("mcp.js");
const { budgetViolations, percentile } = await load("runtime/performance-budgets.js");
const { EslintAdapter } = await load("diagnostics/eslint-adapter.js");
const { ReactDoctorAdapter } = await load("diagnostics/react-doctor-adapter.js");
const { Client } = await import("@modelcontextprotocol/client");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");

const samples = { startupMs: [], packageSnapshotLoadMs: [], readerMs: [], bundleMs: [], indexMs: [], incrementalQueryMs: [], eslintMs: [], reactDoctorMs: [], mcpResponseMs: [] };
const time = async (metric, run) => {
  const started = performance.now();
  const result = await run();
  samples[metric].push(Math.round(performance.now() - started));
  return result;
};
const analyzer = await SharedFactsAnalyzer.create();
const cli = path.join(options.package, "dist", "cli.js");
const repositories = (await fs.readdir(options.fleet, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

async function copyWithoutDependencies(source, target) {
  await fs.cp(source, target, { recursive: true, filter: (item) => !item.split(path.sep).includes("node_modules") && !item.split(path.sep).includes(".git") });
}

for (let run = 0; run < options.runs; run++) {
  for (const name of repositories) {
    const root = await fs.realpath(path.join(options.fleet, name));
    // A cold CLI process: registry load, repo-facts, extensions, and one response.
    await time("startupMs", () => execFileAsync(process.execPath, [cli, "context", "overview", "--json"], { cwd: root, env: { ...process.env, WEB_DOCTOR_REGISTRY_ROOT: options.registry }, maxBuffer: 64 * 1024 * 1024 }));
    await time("packageSnapshotLoadMs", () => loadEmbeddedRegistry({ root: options.registry }));
    const listing = await time("readerMs", () => WorkingTreeListing.scan({ root, repositoryRoot: root }));
    await time("bundleMs", () => analyzer.analyze(listing.open()));
    await time("indexMs", () => buildProjectIndex(listing.open()));

    // Provider time is measured by diagnostics with one engine's adapter, after the project state is ready.
    for (const [metric, provider, adapter] of [["eslintMs", "eslint", new EslintAdapter()], ["reactDoctorMs", "react-doctor", new ReactDoctorAdapter()]]) {
      const single = await WebDoctor.open({ cwd: root, caller: "cli", registryRoot: options.registry, watch: false, analyzer, adapters: [adapter] });
      try {
        const { report } = await time(metric, () => single.diagnose());
        const execution = report.runs.find((entry) => entry.provider === provider);
        if (execution === undefined) throw new Error(`${name}: the measurement registry must select ${provider} rules`);
        if (execution.completeness !== "complete") throw new Error(`${name}: ${provider} was ${execution.completeness}: ${execution.reason}`);
      } finally {
        await single.close();
      }
    }
    const core = await WebDoctor.open({ cwd: root, caller: "mcp", registryRoot: options.registry, watch: false, analyzer });
    try {
      const server = createWebDoctorServer(core);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "performance", version: "1.0.0" });
      await client.connect(clientTransport);
      await client.callTool({ name: "project_overview", arguments: {} });
      for (const [tool, input] of [["project_overview", {}], ["explain_symbol", { symbol: "App" }], ["effective_guidance", {}]]) await time("mcpResponseMs", () => client.callTool({ name: tool, arguments: input }));
      await client.close();
      await server.close();
    } finally {
      await core.close();
    }

    // Incremental query: a watched copy observes one edit and answers from the new state.
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-performance-"));
    try {
      await copyWithoutDependencies(root, copy);
      const watched = await WebDoctor.open({ cwd: copy, caller: "mcp", registryRoot: options.registry, watch: true, analyzer });
      try {
        const before = (await watched.context({ query: "project_overview" })).provenance.project.treeDigest;
        const source = (await fs.readdir(copy, { recursive: true })).filter((file) => /\.[jt]sx?$/.test(file) && !/(^|\/)(dist|test|tests)\//.test(file) && !/\.config\./.test(file)).sort()[0];
        if (source === undefined) throw new Error(`${name}: no source file to edit`);
        await time("incrementalQueryMs", async () => {
          await fs.appendFile(path.join(copy, source), `\nexport const performanceProbe${run} = ${run};\n`);
          for (let attempt = 0; attempt < 200; attempt++) {
            const response = await watched.context({ query: "project_overview" });
            if (response.provenance.project.treeDigest !== before) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`${name}: the edit was not observed`);
        });
      } finally {
        await watched.close();
      }
    } finally {
      await fs.rm(copy, { recursive: true, force: true });
    }
    process.stderr.write(`run ${run + 1}/${options.runs} ${name}\n`);
  }
}

const summary = Object.fromEntries(Object.entries(samples).map(([metric, values]) => [metric, { samples: values.length, p50Ms: percentile(values, 50), p95Ms: percentile(values, 95), maxMs: Math.max(...values) }]));
const budgets = JSON.parse(await fs.readFile(path.join(repository, "performance", "budgets.json"), "utf8").catch(() => "null"));
const violations = budgets === null ? [] : budgetViolations(samples, budgets);
const result = { schema: "web-doctor.performance-measurement", schemaVersion: 1, node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, runs: options.runs, repositories, summary, samples, violations };
if (options.out !== null) await fs.writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`);
for (const [metric, value] of Object.entries(summary)) process.stderr.write(`${metric}: p50 ${value.p50Ms} ms, p95 ${value.p95Ms} ms, max ${value.maxMs} ms\n`);
for (const violation of violations) process.stderr.write(`BUDGET: ${violation.message}\n`);
if (options.check && violations.length > 0) process.exitCode = 1;
