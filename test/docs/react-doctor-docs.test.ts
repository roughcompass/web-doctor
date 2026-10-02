import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderManifest } from "../../src/contracts/index.js";
import { loadProviderApproval, rulesetDigest } from "../../src/diagnostics/provider-approval.js";
import type { FindingDraft } from "../../src/diagnostics/finding.js";
import { FULL_SCOPE } from "../../src/diagnostics/providers.js";
import { ReactDoctorAdapter } from "../../src/diagnostics/react-doctor-adapter.js";
import { analyzeProject } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FLEET = process.env.WEB_DOCTOR_FLEET_ROOT ?? path.resolve(ROOT, "../fleet");
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

interface Evaluation {
  reactDoctor: { version: string; integrity: string; contentDigest: string; rulesetDigest: string; outputSchemaVersions: number[]; rules: number };
  fleet: { app: string; completeness: string; treeUnchanged: boolean; denied: string[]; findings: number; items: { rule: string; path: string; line: number }[] }[];
  totals: { apps: number; complete: number; treesUnchanged: boolean; networkAttempts: number };
}

const evaluation = read("evidence/react-doctor-evaluation.json") as Evaluation;
const review = read("evidence/react-doctor-review.json") as { findings: { app: string; path: string; line: number; rule: string; verdict: string }[] };

describe("React Doctor decision and evaluation", () => {
  it("records the exact approved package, rule set, and report schema it evaluated", async () => {
    const approval = (await loadProviderApproval("react-doctor"))!;
    const release = approval.releases[0]!;
    expect(evaluation.reactDoctor).toMatchObject({ version: release.version, integrity: release.integrity, contentDigest: release.contentDigest, rulesetDigest: release.rulesetDigest, outputSchemaVersions: release.outputSchemaVersions });
    expect(rulesetDigest(read("examples/react-doctor-provider/rules.json"))).toBe(release.rulesetDigest);
    expect(evaluation.reactDoctor.rules).toBe((read("examples/react-doctor-provider/provider.json") as ProviderManifest).rules.length);
    const installed = read("node_modules/react-doctor/package.json") as { version: string };
    expect(installed.version).toBe(release.version);
    expect(read("package.json").optionalDependencies["react-doctor"]).toBe(release.version);
  });

  it("evaluated every fleet application completely, offline, and without changing it", () => {
    expect(evaluation.totals).toMatchObject({ apps: 8, complete: 8, treesUnchanged: true, networkAttempts: 0 });
    for (const app of evaluation.fleet) expect(app, app.app).toMatchObject({ completeness: "complete", treeUnchanged: true, denied: [] });
  });

  it("reviewed every finding and documents the same results", () => {
    const key = (entry: { app: string; path: string; line: number; rule: string }) => `${entry.app}:${entry.path}:${entry.line}:${entry.rule}`;
    const found = evaluation.fleet.flatMap((app) => app.items.map((item) => key({ app: app.app, ...item }))).sort();
    expect(review.findings.map(key).sort()).toEqual(found);
    for (const entry of review.findings) expect(["true_positive", "false_positive", "needs_context"]).toContain(entry.verdict);
    const document = fs.readFileSync(path.join(ROOT, "docs/react-doctor-evaluation.md"), "utf8");
    for (const app of evaluation.fleet) expect(document).toMatch(new RegExp(`\\| ${app.app} \\| complete \\| \\d+ \\| ${app.findings} \\|`));
    for (const entry of review.findings) expect(document).toContain(`**${entry.app}, \`${entry.rule}\`:**`);
    const decision = fs.readFileSync(path.join(ROOT, "docs/react-doctor.md"), "utf8");
    expect(decision).toContain("React Doctor 0.9.14 is approved for internal enterprise use");
  });

  it.runIf(fs.existsSync(FLEET))("reproduces the recorded findings against the fleet", async () => {
    const manifest = read("examples/react-doctor-provider/provider.json") as ProviderManifest;
    const registryRoot = fs.mkdtempSync(path.join(ROOT, "node_modules", ".react-doctor-evaluation-"));
    try {
      fs.mkdirSync(path.join(registryRoot, "contributions", "react-doctor"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "examples/react-doctor-provider/rules.json"), path.join(registryRoot, "contributions", "react-doctor", "rules.json"));
      const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
      const adapter = new ReactDoctorAdapter();
      const plan = { provider: "react-doctor", engine: "react-doctor", manifest, contribution: "react-doctor", rules: manifest.rules.map((rule) => rule.id), requirements: [], unavailable: null };
      for (const app of evaluation.fleet) {
        const root = path.join(FLEET, app.app);
        const snapshot = await analyzeProject({ root, analyzer });
        const [execution] = await adapter.run([plan], { root, repositoryRoot: null, registryRoot, registry: {} as never, providerContributions: { "react-doctor": "react-doctor" }, snapshot, scope: FULL_SCOPE });
        expect(execution!.completeness, app.app).toBe("complete");
        const locate = (draft: FindingDraft) => (draft.locations[0]!.kind === "source" ? `${draft.locations[0]!.path}:${draft.locations[0]!.line}:${draft.rule}` : "");
        expect(execution!.drafts.map(locate).sort(), app.app).toEqual(app.items.map((item) => `${item.path}:${item.line}:${item.rule}`).sort());
      }
    } finally {
      fs.rmSync(registryRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
