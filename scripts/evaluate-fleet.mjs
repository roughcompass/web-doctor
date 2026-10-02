#!/usr/bin/env node
// Runs each project-context stage independently against every fleet
// repository: the working-tree reader, the pinned repo-facts bundle, the Web
// Doctor extension index, and policy resolution. Uses the Web Doctor package
// at --package, such as a managed installation, and its embedded registry.
// No repository script runs: child processes and network are trapped and
// recorded, and each tree is digested before and after.
//
// Usage: node scripts/evaluate-fleet.mjs --package <dir> [--registry <dir>] [--out <file>] <fleet-root>

import child from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const options = { package: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), registry: null, out: null, fleet: null };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
  const value = argv[index];
  if (value === "--package" || value === "--registry" || value === "--out") options[value.slice(2)] = path.resolve(argv[++index]);
  else options.fleet = path.resolve(value);
}
if (options.fleet === null) throw new Error("Usage: node scripts/evaluate-fleet.mjs --package <dir> [--registry <dir>] [--out <file>] <fleet-root>");

// Record every process start and network attempt made while the stages run.
const spawned = [];
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = child[name];
  child[name] = function trapped(command, ...rest) {
    spawned.push({ api: name, command: String(command), args: Array.isArray(rest[0]) ? rest[0].map(String) : [] });
    return original.call(this, command, ...rest);
  };
}
const connections = [];
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function trapped(...args) {
  connections.push(JSON.stringify(args[0]).slice(0, 200));
  return connect.apply(this, args);
};

const load = (relative) => import(path.join(options.package, "dist", relative));
const { WorkingTreeListing } = await load("facts/working-tree-reader.js");
const { SharedFactsAnalyzer } = await load("facts/shared-facts.js");
const { buildProjectIndex } = await load("facts/project-index.js");
const { analyzeProject } = await load("facts/project-snapshot.js");
const { policyFactsFor } = await load("core/policy-facts.js");
const { composePolicy } = await load("runtime/policy-composition.js");
const { createEffectivePolicySnapshot } = await load("runtime/effective-policy.js");
const { loadEmbeddedRegistry } = await load("runtime/embedded-registry.js");
const { WEB_DOCTOR_VERSION } = await load("version.js");

const registry = await loadEmbeddedRegistry(options.registry === null ? {} : { root: options.registry });
const analyzer = await SharedFactsAnalyzer.create();
if (analyzer.availability.status !== "available") throw new Error(`The pinned repo-facts release is unavailable: ${analyzer.availability.problems.join("; ")}`);

async function treeDigest(directory) {
  const hash = crypto.createHash("sha256");
  const walk = async (current) => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      hash.update(`${path.relative(directory, full)}\0`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) hash.update(await fs.readFile(full));
    }
  };
  await walk(directory);
  return hash.digest("hex");
}

async function stage(run) {
  const started = performance.now();
  try {
    return { ...(await run()), durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - started) };
  }
}

const repositories = (await fs.readdir(options.fleet, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const results = [];
for (const name of repositories) {
  const root = await fs.realpath(path.join(options.fleet, name));
  const before = await treeDigest(root);
  const spawnedBefore = spawned.length;
  const reader = await stage(async () => {
    const listing = await WorkingTreeListing.scan({ root, repositoryRoot: root });
    return { status: "complete", files: listing.entries.length, exclusions: listing.exclusions.map((exclusion) => `${exclusion.reason}:${exclusion.path}`).sort(), digest: listing.digest };
  });
  const bundle = await stage(async () => {
    const result = await analyzer.analyze((await WorkingTreeListing.scan({ root, repositoryRoot: root })).open());
    if (result.status !== "complete") return { status: "incomplete", reason: result.reason, problems: result.problems };
    return {
      status: result.incompleteCategories.length === 0 ? "complete" : "incomplete",
      detectorRelease: result.provenance.detectorRelease,
      configurationDigest: result.provenance.configurationDigest,
      factDocumentDigest: result.documentDigest,
      incompleteCategories: [...result.incompleteCategories].sort(),
      skippedInputs: result.skippedInputs.map((input) => `${input.reason}:${input.path}`).sort(),
      packageManagers: result.document.categories.package_managers?.facts.map((fact) => String(fact.value)).sort() ?? [],
      frameworks: result.document.categories.frameworks?.facts.map((fact) => fact.key).sort() ?? [],
      buildTools: result.document.categories.build_tools?.facts.map((fact) => fact.key).sort() ?? [],
    };
  });
  const index = await stage(async () => {
    const built = await buildProjectIndex((await WorkingTreeListing.scan({ root, repositoryRoot: root })).open());
    return { status: built.complete ? "complete" : "incomplete", modules: built.modules.length, components: built.symbols.filter((symbol) => symbol.kind === "component").length, hooks: built.symbols.filter((symbol) => symbol.kind === "hook").length, skipped: built.skipped.map((skip) => `${skip.reason}:${skip.path}`).sort(), digest: built.digest };
  });
  const policy = await stage(async () => {
    const snapshot = await analyzeProject({ root, repositoryRoot: root, analyzer });
    const facts = policyFactsFor(snapshot, registry.snapshot, null);
    const composition = composePolicy({ registry: registry.snapshot, portalSelection: {}, facts: facts.facts });
    const effective = createEffectivePolicySnapshot({ composition, capabilityCertainty: facts.capabilityCertainty, facts: facts.provenance });
    return {
      status: effective.unresolvedApplicability.length === 0 && effective.conflicts.length === 0 ? "complete" : "incomplete",
      policyDigest: effective.digest,
      registryDigest: effective.registryDigest,
      extensionStateDigest: effective.facts.extensionStateDigest,
      factStatus: effective.facts.status,
      controls: effective.controls.map((entry) => entry.control.id).sort(),
      unresolvedApplicability: [...effective.unresolvedApplicability].sort(),
      capabilities: facts.facts.capabilities ?? {},
    };
  });
  results.push({ repository: name, reader, bundle, index, policy, processes: spawned.slice(spawnedBefore), treeUnchanged: before === (await treeDigest(root)) });
  process.stderr.write(`${name}: reader ${reader.status}, bundle ${bundle.status}, index ${index.status}, policy ${policy.status}\n`);
}

const evidence = {
  schema: "web-doctor.fleet-evaluation",
  schemaVersion: 1,
  webDoctorVersion: WEB_DOCTOR_VERSION,
  installation: process.env.WEB_DOCTOR_INSTALLATION_MODE === "managed" ? "managed" : "source",
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  registryDigest: registry.digest,
  repoFacts: analyzer.availability.release,
  repositories: results,
  networkAttempts: connections,
};
const out = options.out ?? path.join(options.package, "evidence", "fleet-evaluation.json");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
process.stderr.write(`Wrote ${out}\n`);
