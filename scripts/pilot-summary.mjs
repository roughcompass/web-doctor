#!/usr/bin/env node
// Summarizes an advisory pilot directory:
//   records/*.json       runs captured by scripts/pilot-record.mjs
//   dispositions.json    reviewed findings: { fingerprint, verdict, reviewer, reason }
//   tasks.json           developer and agent tasks: { id, actor, outcome, tools, notes }
//   readiness-review.json  the platform readiness review, once held
// Reports latency, incomplete checks, suppressions, false-positive dispositions,
// task success, and which Controls meet the readiness criteria for gating.
//
// Usage: node scripts/pilot-summary.mjs <pilot-dir> [--out <file>]

import fs from "node:fs/promises";
import path from "node:path";

const [pilot, ...rest] = process.argv.slice(2);
if (pilot === undefined) throw new Error("Usage: node scripts/pilot-summary.mjs <pilot-dir> [--out <file>]");
const out = rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : undefined;
const readJson = async (file, fallback) => JSON.parse(await fs.readFile(path.join(pilot, file), "utf8").catch(() => JSON.stringify(fallback)));

/** Criteria a Control must meet before the readiness review may approve it for gating. */
export const CRITERIA = { minimumDispositions: 20, maximumFalsePositiveRate: 0.05, maximumIncompleteRate: 0.05, maximumSuppressionRate: 0.1 };

const percentile = (values, rank) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))];
};

const records = [];
for (const file of (await fs.readdir(path.join(pilot, "records")).catch(() => [])).filter((name) => name.endsWith(".json")).sort()) {
  records.push(JSON.parse(await fs.readFile(path.join(pilot, "records", file), "utf8")));
}
const dispositions = await readJson("dispositions.json", []);
const tasks = await readJson("tasks.json", []);
const review = await readJson("readiness-review.json", null);

const latency = {};
for (const record of records) {
  const key = record.command.filter((argument) => !argument.startsWith("-")).slice(0, 2).join(" ");
  (latency[key] ??= []).push(record.elapsedMs);
}

const reports = records.filter((record) => record.response?.tool === "run_diagnostics").map((record) => ({ app: record.app, report: record.response.data }));
const findings = new Map();
const controls = new Map();
const providers = new Map();
for (const { app, report } of reports) {
  for (const run of report.runs) {
    const entry = providers.get(run.provider) ?? { runs: 0, incomplete: 0, reasons: new Set() };
    entry.runs += 1;
    if (run.completeness !== "complete") {
      entry.incomplete += 1;
      if (run.reason !== null) entry.reasons.add(run.reason);
    }
    providers.set(run.provider, entry);
  }
  for (const outcome of report.controls) {
    const entry = controls.get(outcome.control) ?? { control: outcome.control, strength: outcome.strength, evaluations: 0, incomplete: 0, findings: new Set() };
    entry.evaluations += 1;
    if (outcome.status === "incomplete" || outcome.status === "not_evaluated") entry.incomplete += 1;
    for (const id of outcome.findings) entry.findings.add(id);
    controls.set(outcome.control, entry);
  }
  for (const finding of report.findings) findings.set(finding.fingerprint, { app, finding });
}

const verdicts = new Map(dispositions.map((entry) => [entry.fingerprint, entry]));
const byControl = [...controls.values()].map((entry) => {
  const related = [...findings.values()].filter(({ finding }) => finding.controls.includes(entry.control));
  const disposed = related.filter(({ finding }) => verdicts.has(finding.fingerprint));
  const falsePositives = disposed.filter(({ finding }) => verdicts.get(finding.fingerprint).verdict === "false_positive").length;
  const suppressed = related.filter(({ finding }) => finding.suppression !== null).length;
  const incompleteRate = entry.evaluations === 0 ? 0 : entry.incomplete / entry.evaluations;
  const falsePositiveRate = disposed.length === 0 ? null : falsePositives / disposed.length;
  const suppressionRate = related.length === 0 ? 0 : suppressed / related.length;
  const blockers = [
    ...(disposed.length < CRITERIA.minimumDispositions ? [`${disposed.length} of ${CRITERIA.minimumDispositions} required dispositions`] : []),
    ...(falsePositiveRate !== null && falsePositiveRate > CRITERIA.maximumFalsePositiveRate ? [`false-positive rate ${(falsePositiveRate * 100).toFixed(1)}%`] : []),
    ...(incompleteRate > CRITERIA.maximumIncompleteRate ? [`incomplete in ${(incompleteRate * 100).toFixed(1)}% of evaluations`] : []),
    ...(suppressionRate > CRITERIA.maximumSuppressionRate ? [`${(suppressionRate * 100).toFixed(1)}% of findings suppressed`] : []),
  ];
  return { control: entry.control, strength: entry.strength, evaluations: entry.evaluations, findings: related.length, dispositions: disposed.length, falsePositiveRate, incompleteRate, suppressionRate, meetsCriteria: blockers.length === 0, blockers };
}).sort((left, right) => (left.control < right.control ? -1 : 1));

const approved = new Set(review?.approvedForGating?.map((entry) => entry.control) ?? []);
const summary = {
  schema: "web-doctor.pilot-summary",
  schemaVersion: 1,
  records: records.length,
  apps: [...new Set(records.map((record) => record.app))].sort(),
  latencyMs: Object.fromEntries(Object.entries(latency).map(([command, values]) => [command, { runs: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) }])),
  providers: Object.fromEntries([...providers].map(([provider, entry]) => [provider, { runs: entry.runs, incomplete: entry.incomplete, reasons: [...entry.reasons].sort() }])),
  findings: { total: findings.size, suppressed: [...findings.values()].filter(({ finding }) => finding.suppression !== null).length, disposed: [...findings.keys()].filter((fingerprint) => verdicts.has(fingerprint)).length },
  dispositions: Object.fromEntries(["true_positive", "false_positive", "wont_fix", "needs_context"].map((verdict) => [verdict, dispositions.filter((entry) => entry.verdict === verdict).length])),
  tasks: {
    total: tasks.length,
    byActor: Object.fromEntries(["developer", "agent"].map((actor) => {
      const own = tasks.filter((task) => task.actor === actor);
      return [actor, { total: own.length, success: own.filter((task) => task.outcome === "success").length, partial: own.filter((task) => task.outcome === "partial").length, failure: own.filter((task) => task.outcome === "failure").length }];
    })),
  },
  criteria: CRITERIA,
  controls: byControl,
  readinessReview: review === null ? null : { heldOn: review.heldOn, approvedBy: review.approvedBy, approvedForGating: [...approved].sort() },
  approvedWithoutMeetingCriteria: review === null ? [] : [...approved].filter((control) => !byControl.find((entry) => entry.control === control)?.meetsCriteria).sort(),
};
if (out !== undefined) await fs.writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
