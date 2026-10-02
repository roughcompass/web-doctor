#!/usr/bin/env node
// Evaluates the approved React Doctor release against fleet applications:
// output schema, completeness, latency, findings by rule and category, and
// rule-level overlap with ESLint. Runs the real Web Doctor adapter, so every
// run is bounded, offline, and read-only, and verifies each application tree
// is unchanged afterwards. Writes evidence/react-doctor-evaluation.json.
//
// Usage: node scripts/evaluate-react-doctor.mjs <fleet-root> [app ...]

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (relative) => import(path.join(root, "dist", relative));
const { ReactDoctorAdapter } = await dist("diagnostics/react-doctor-adapter.js");
const { loadProviderApproval } = await dist("diagnostics/provider-approval.js");
const { FULL_SCOPE } = await dist("diagnostics/providers.js");
const { analyzeProject } = await dist("facts/project-snapshot.js");
const { SharedFactsAnalyzer } = await dist("facts/shared-facts.js");
const { WEB_DOCTOR_VERSION } = await dist("version.js");

const [fleetArgument, ...only] = process.argv.slice(2);
if (fleetArgument === undefined) throw new Error("Usage: node scripts/evaluate-react-doctor.mjs <fleet-root> [app ...]");
const fleet = await fs.realpath(fleetArgument);
const apps = only.length > 0 ? only : (await fs.readdir(fleet, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

const example = path.join(root, "examples", "react-doctor-provider");
const manifest = JSON.parse(await fs.readFile(path.join(example, "provider.json"), "utf8"));
const catalog = JSON.parse(await fs.readFile(path.join(example, "rules.json"), "utf8"));
const approval = await loadProviderApproval("react-doctor");
const release = approval.releases.find((candidate) => candidate.version === manifest.engineRange);

// The adapter reads the approved rule catalog from an embedded registry layout.
const registryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-react-doctor-evaluation-"));
await fs.mkdir(path.join(registryRoot, "contributions", "react-doctor"), { recursive: true });
await fs.copyFile(path.join(example, "rules.json"), path.join(registryRoot, "contributions", "react-doctor", "rules.json"));

const analyzer = await SharedFactsAnalyzer.create();
const adapter = new ReactDoctorAdapter({ limits: { timeoutMs: 300_000, memoryMb: 4_096, outputBytes: 64 * 1024 * 1024 } });
const plan = { provider: "react-doctor", engine: "react-doctor", manifest, contribution: "react-doctor", rules: manifest.rules.map((rule) => rule.id), requirements: [], unavailable: null };

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

const results = [];
for (const name of apps) {
  const appRoot = path.join(fleet, name);
  const before = await treeDigest(appRoot);
  const snapshot = await analyzeProject({ root: appRoot, analyzer });
  const started = performance.now();
  const [execution] = await adapter.run([plan], { root: appRoot, repositoryRoot: null, registryRoot, registry: { providers: [manifest] }, providerContributions: { "react-doctor": "react-doctor" }, snapshot, scope: FULL_SCOPE });
  const latencyMs = Math.round(performance.now() - started);
  const after = await treeDigest(appRoot);
  const findings = execution.drafts.map((draft) => ({
    rule: draft.rule,
    category: draft.original.category,
    severity: draft.severity,
    path: draft.locations[0].path,
    line: draft.locations[0].line,
    message: draft.message,
  })).sort((left, right) => (`${left.path}:${String(left.line).padStart(6, "0")}:${left.rule}` < `${right.path}:${String(right.line).padStart(6, "0")}:${right.rule}` ? -1 : 1));
  const count = (key) => Object.fromEntries([...findings.reduce((map, finding) => map.set(finding[key], (map.get(finding[key]) ?? 0) + 1), new Map())].sort());
  results.push({
    app: name,
    completeness: execution.completeness,
    reason: execution.reason,
    engineVersion: execution.engineVersion,
    analyzedFiles: execution.files,
    latencyMs,
    denied: execution.denied,
    treeUnchanged: before === after,
    findings: findings.length,
    byCategory: count("category"),
    byRule: count("rule"),
    items: findings,
  });
  process.stderr.write(`${name}: ${execution.completeness} ${findings.length} findings in ${latencyMs} ms\n`);
}
await fs.rm(registryRoot, { recursive: true, force: true });

// Rule-level overlap: React Doctor rules whose names ESLint core or the React Hooks plugin also define.
const require = createRequire(import.meta.url);
const { builtinRules } = require(require.resolve("eslint/use-at-your-own-risk", { paths: [root] }));
const reactHooks = require(require.resolve("eslint-plugin-react-hooks", { paths: [path.join(root, "node_modules", "react-doctor")] }));
const enterprise = [];
for (const directory of ["adobe-analytics-governance", "web-runtime-governance"]) {
  const provider = JSON.parse(await fs.readFile(path.join(root, "examples", directory, "provider.json"), "utf8"));
  for (const rule of provider.rules) enterprise.push(`${provider.id}/${rule.id}`);
}
const ids = catalog.rules.map((rule) => rule.id);
const overlap = {
  eslintCore: ids.filter((id) => builtinRules.has(id)).sort(),
  reactHooks: ids.filter((id) => Object.hasOwn(reactHooks.rules ?? reactHooks.default?.rules ?? {}, id)).sort(),
  enterprise: enterprise.filter((id) => ids.includes(id.split("/").at(-1))).sort(),
};

const evidence = {
  schema: "web-doctor.react-doctor-evaluation",
  schemaVersion: 1,
  webDoctorVersion: WEB_DOCTOR_VERSION,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  reactDoctor: {
    version: release.version,
    integrity: release.integrity,
    contentDigest: release.contentDigest,
    rulesetDigest: release.rulesetDigest,
    outputSchemaVersions: release.outputSchemaVersions,
    rules: ids.length,
    enabledByDefault: catalog.rules.filter((rule) => rule.defaultEnabled).length,
  },
  configuration: approval.security.configuration,
  fleet: results,
  totals: {
    apps: results.length,
    complete: results.filter((result) => result.completeness === "complete").length,
    findings: results.reduce((total, result) => total + result.findings, 0),
    latencyMs: { max: Math.max(...results.map((result) => result.latencyMs)), total: results.reduce((total, result) => total + result.latencyMs, 0) },
    treesUnchanged: results.every((result) => result.treeUnchanged),
    networkAttempts: results.filter((result) => result.denied.includes("network")).length,
  },
  overlap,
};
await fs.mkdir(path.join(root, "evidence"), { recursive: true });
await fs.writeFile(path.join(root, "evidence", "react-doctor-evaluation.json"), `${JSON.stringify(evidence, null, 2)}\n`);
process.stderr.write(`Wrote evidence/react-doctor-evaluation.json: ${evidence.totals.findings} findings across ${evidence.totals.apps} applications\n`);
