import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryFile } from "@repo-facts/contract";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FindingObligation, NormalizedFinding } from "../../src/contracts/index.js";
import { buildFinding } from "../../src/diagnostics/finding.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { sharedRepairs } from "../../src/guidance/impact.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIGEST = "d".repeat(64);
const temporaryDirectories: string[] = [];
let analyzer: SharedFactsAnalyzer;

beforeAll(async () => {
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const page = (name: string, tabs: string) => [
  'import { Layout } from "../components/Layout";',
  'import { Tabs } from "../components/Tabs";',
  "",
  `export function ${name}() {`,
  "  return (",
  "    <Layout>",
  `      ${tabs}`,
  "    </Layout>",
  "  );",
  "}",
  "",
].join("\n");

const TABS_APP: Record<string, MemoryFile> = {
  "package.json": `${JSON.stringify({ name: "wealth-portal", private: true, scripts: { test: "vitest run" }, dependencies: { react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "6.30.1" }, devDependencies: { vitest: "3.2.4" } }, null, 2)}\n`,
  "src/components/Tabs.tsx": [
    "export function Tabs({ items, label }: { items: string[]; label?: string }) {",
    "  return (",
    '    <div role="tablist" aria-label={label}>',
    '      {items.map((item) => <button key={item} role="tab">{item}</button>)}',
    "    </div>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "src/components/Layout.tsx": "export function Layout({ children }: { children: React.ReactNode }) {\n  return <main>{children}</main>;\n}\n",
  "src/pages/Orders.tsx": page("Orders", '<Tabs items={["Open", "Filled"]} />'),
  "src/pages/Accounts.tsx": page("Accounts", '<Tabs items={["Cash", "Margin"]} />'),
  "src/pages/Reports.tsx": page("Reports", '<Tabs items={["Daily", "Monthly"]} />'),
  "src/pages/Settings.tsx": page("Settings", '<Tabs items={["Profile", "Alerts"]} label="Settings sections" />'),
  "src/App.tsx": [
    'import { Route, Routes } from "react-router-dom";',
    'import { Accounts } from "./pages/Accounts";',
    'import { Orders } from "./pages/Orders";',
    'import { Reports } from "./pages/Reports";',
    'import { Settings } from "./pages/Settings";',
    "",
    "export function App() {",
    "  return (",
    "    <Routes>",
    '      <Route path="/orders" element={<Orders />} />',
    '      <Route path="/accounts" element={<Accounts />} />',
    '      <Route path="/reports" element={<Reports />} />',
    '      <Route path="/settings" element={<Settings />} />',
    "    </Routes>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "src/components/Tabs.test.tsx": 'import { Tabs } from "./Tabs";\n\ntest("renders", () => {\n  Tabs({ items: [] });\n});\n',
  "src/pages/Orders.test.tsx": 'import { Orders } from "./Orders";\n\ntest("renders", () => {\n  Orders();\n});\n',
};

const OBLIGATION: FindingObligation = { control: "firm/accessibility/tablist-name", title: "Tab lists have accessible names", strength: "required", layer: "firmwide", policy: "firm/accessibility", contribution: "firm/accessibility", remediation: "Name each tab list.", verification: [{ kind: "axe", description: "Check the rendered tab list." }] };

function sourceFinding(file: string, line: number, column = 7): NormalizedFinding {
  return buildFinding({
    provider: { id: "wealth-design", version: "2.0.0", engine: "eslint", engineVersion: "9.39.5", contribution: "wealth/design-lint" }, rule: "tabs-label", evidenceKind: "static",
    locations: [{ kind: "source", path: file, line, column, endLine: line, endColumn: column + 30 }], severity: "error", certainty: "observed", classification: "defect",
    message: "Tabs needs a label", completeness: "complete", original: { ruleId: "wealth-design/tabs-label" },
  }, { obligations: [OBLIGATION], registryDigest: DIGEST, policyDigest: DIGEST });
}

function renderedFinding(route: string): NormalizedFinding {
  return buildFinding({
    provider: { id: "axe", version: "4.13.0", engine: "axe-core", engineVersion: "4.13.0", contribution: null }, rule: "aria-input-field-name", evidenceKind: "rendered",
    locations: [{ kind: "rendered", url: `http://127.0.0.1:4000${route}`, route, state: "default", viewport: { width: 1280, height: 800 }, target: ["[role=tablist]"] }], severity: "error", certainty: "observed", classification: "defect",
    message: "ARIA tablist needs an accessible name", completeness: "complete", original: { id: "aria-input-field-name" },
  }, { obligations: [OBLIGATION], registryDigest: DIGEST, policyDigest: DIGEST });
}

async function snapshotOf(files: Record<string, MemoryFile>): Promise<ProjectSnapshot> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-impact-")));
  temporaryDirectories.push(root);
  await materialize(root, files);
  return analyzeProject({ root, repositoryRoot: root, analyzer });
}

describe("shared abstraction and impact", () => {
  it("traces repeated Tabs findings to one owner and keeps every location, consumer, and obligation", async () => {
    const snapshot = await snapshotOf(TABS_APP);
    const findings = [sourceFinding("src/pages/Orders.tsx", 7), sourceFinding("src/pages/Accounts.tsx", 7), sourceFinding("src/pages/Reports.tsx", 7)];
    const { repairs, independent } = sharedRepairs({ findings, snapshot });
    expect(independent).toEqual([]);
    expect(repairs).toHaveLength(1);
    const [repair] = repairs;
    expect(repair!.owner).toMatchObject({ symbol: "src/components/Tabs.tsx#Tabs", path: "src/components/Tabs.tsx", via: ["usage"], certainty: "observed", published: false, exposures: [] });
    expect(repair!.owner!.covers).toHaveLength(3);
    expect(repair!.locations.map((location) => (location.kind === "source" ? `${location.path}:${location.line}` : location.url))).toEqual(["src/pages/Accounts.tsx:7", "src/pages/Orders.tsx:7", "src/pages/Reports.tsx:7"]);
    expect(repair!.findings.sort()).toEqual(findings.map((finding) => finding.id).sort());
    expect(repair!.consumers.map((consumer) => [consumer.module, consumer.symbol, consumer.flagged, consumer.findings.length])).toEqual([
      ["src/pages/Accounts.tsx", "src/pages/Accounts.tsx#Accounts", true, 1],
      ["src/pages/Orders.tsx", "src/pages/Orders.tsx#Orders", true, 1],
      ["src/pages/Reports.tsx", "src/pages/Reports.tsx#Reports", true, 1],
      ["src/pages/Settings.tsx", "src/pages/Settings.tsx#Settings", false, 0],
    ]);
    expect(repair!.obligations).toEqual([OBLIGATION]);
    expect(repair!.uncertainty).toEqual([]);
  });

  it("orders the shared repair before local edits and scopes verification to affected tests and routes", async () => {
    const snapshot = await snapshotOf(TABS_APP);
    const [repair] = sharedRepairs({ findings: [sourceFinding("src/pages/Orders.tsx", 7), sourceFinding("src/pages/Accounts.tsx", 7), sourceFinding("src/pages/Reports.tsx", 7)], snapshot }).repairs;
    expect(repair!.order).toEqual([
      "Repair Tabs in src/components/Tabs.tsx; it accounts for 3 findings in 3 consumers",
      "Run wealth-design tabs-label again across every affected consumer, including 1 without a finding",
      "Edit a consumer only where its finding remains after the shared repair",
    ]);
    expect(repair!.tests.map((view) => view.key)).toEqual(["src/components/Tabs.test.tsx", "src/pages/Orders.test.tsx"]);
    expect(repair!.routes.map((view) => (view.value as { path: { value: string } }).path.value).sort()).toEqual(["/accounts", "/orders", "/reports", "/settings"]);
    expect(repair!.verification.map((step) => step.kind)).toEqual(["test", "test", "rendered", "rendered", "rendered", "rendered", "check"]);
    expect(repair!.verification.at(-1)!.description).toBe("Run wealth-design tabs-label on src/components/Tabs.tsx, src/pages/Accounts.tsx, src/pages/Orders.tsx, src/pages/Reports.tsx, src/pages/Settings.tsx");
    expect(repair!.modifiesProject).toBe(false);
  });

  it("keeps rendered findings uncertain when several components render on every flagged route", async () => {
    const snapshot = await snapshotOf(TABS_APP);
    const findings = [renderedFinding("/orders"), renderedFinding("/accounts")];
    const [repair] = sharedRepairs({ findings, snapshot }).repairs;
    expect(repair!.owner).toBeNull();
    expect(repair!.candidates.filter((candidate) => candidate.covers.length === 2).map((candidate) => [candidate.name, candidate.certainty])).toEqual([["Layout", "inferred"], ["Tabs", "inferred"]]);
    expect(repair!.uncertainty).toEqual([
      "2 rendered findings map to source only through route elements and the components they render",
      "Layout, Tabs each account for every finding; Web Doctor cannot tell which one produces them",
    ]);
    expect(repair!.locations).toHaveLength(2);
    expect(repair!.order[0]).toBe("Inspect Layout, Tabs first; they account for several of these findings");
  });

  it("treats findings in one consumer, or with no common component, as independent", async () => {
    const snapshot = await snapshotOf(TABS_APP);
    const single = sourceFinding("src/pages/Orders.tsx", 7);
    const elsewhere = { ...sourceFinding("src/App.tsx", 9, 5) };
    expect(sharedRepairs({ findings: [single], snapshot })).toEqual({ repairs: [], independent: [single.id] });
    const unrelated = sharedRepairs({ findings: [sourceFinding("src/pages/Orders.tsx", 4, 1), elsewhere], snapshot });
    expect(unrelated.repairs).toEqual([]);
    expect(unrelated.independent).toHaveLength(2);
  });

  it("qualifies an owner that a published workspace package provides", async () => {
    const snapshot = await snapshotOf({
      "package.json": `${JSON.stringify({ name: "wealth", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
      "packages/ui/package.json": `${JSON.stringify({ name: "@wealth/ui", version: "4.2.0", dependencies: { react: "18.3.1" } }, null, 2)}\n`,
      "packages/ui/src/Tabs.tsx": TABS_APP["src/components/Tabs.tsx"]!,
      "packages/portal/package.json": `${JSON.stringify({ name: "@wealth/portal", private: true, dependencies: { "@wealth/ui": "4.2.0", react: "18.3.1" } }, null, 2)}\n`,
      "packages/portal/src/Orders.tsx": 'import { Tabs } from "../../ui/src/Tabs";\n\nexport function Orders() {\n  return <Tabs items={["Open"]} />;\n}\n',
      "packages/portal/src/Accounts.tsx": 'import { Tabs } from "../../ui/src/Tabs";\n\nexport function Accounts() {\n  return <Tabs items={["Cash"]} />;\n}\n',
    });
    const [repair] = sharedRepairs({ findings: [sourceFinding("packages/portal/src/Orders.tsx", 4, 10), sourceFinding("packages/portal/src/Accounts.tsx", 4, 10)], snapshot }).repairs;
    expect(repair!.owner).toMatchObject({ path: "packages/ui/src/Tabs.tsx", published: true, package: { source: "shared", category: "package_identity", key: "packages/ui/package.json" } });
    expect(repair!.uncertainty).toContain("@wealth/ui is published, so consumers outside this repository are not visible");
  });
});
