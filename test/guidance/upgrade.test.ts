import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryFile } from "@repo-facts/contract";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GuidanceEntry, RegistrySnapshot } from "../../src/contracts/index.js";
import { analyzeProject, type ProjectSnapshot } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { planUpgrade, type UpgradePlan } from "../../src/guidance/upgrade.js";
import { REACT_UPGRADE_KNOWLEDGE, knowledgeDigest } from "../../src/guidance/upgrade-knowledge.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];
let analyzer: SharedFactsAnalyzer;

beforeAll(async () => {
  analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function manifest(versions: { react: string; reactDom: string; testingLibrary: string }): string {
  return `${JSON.stringify({
    name: "billing",
    private: true,
    packageManager: "npm@10.9.0",
    engines: { node: ">=18" },
    scripts: { build: "webpack --mode production", test: "jest", typecheck: "tsc --noEmit" },
    dependencies: { react: versions.react, "react-dom": versions.reactDom, "react-redux": "7.2.9" },
    devDependencies: { "@testing-library/react": versions.testingLibrary, "@types/react": "17.0.80", jest: "29.7.0", typescript: "5.9.3", webpack: "5.101.0" },
  }, null, 2)}\n`;
}

function lockfile(versions: { react: string; reactDom: string; testingLibrary: string }): string {
  const packages: Record<string, { version: string; dev?: boolean }> = {
    "node_modules/@testing-library/react": { version: versions.testingLibrary, dev: true },
    "node_modules/@types/react": { version: "17.0.80", dev: true },
    "node_modules/jest": { version: "29.7.0", dev: true },
    "node_modules/react": { version: versions.react },
    "node_modules/react-dom": { version: versions.reactDom },
    "node_modules/react-redux": { version: "7.2.9" },
    "node_modules/typescript": { version: "5.9.3", dev: true },
    "node_modules/webpack": { version: "5.101.0", dev: true },
  };
  return `${JSON.stringify({ name: "billing", lockfileVersion: 3, packages: { "": { name: "billing" }, ...packages } }, null, 2)}\n`;
}

const SOURCES: Record<string, string> = {
  "src/index.tsx": [
    'import ReactDOM from "react-dom";',
    'import { App } from "./App";',
    "",
    'ReactDOM.render(<App />, document.getElementById("root"));',
    "",
  ].join("\n"),
  "src/App.tsx": [
    'import { Component } from "react";',
    'import ReactDOM from "react-dom";',
    'import PropTypes from "prop-types";',
    'import { Badge } from "./Badge";',
    "",
    "export class App extends Component {",
    "  static childContextTypes = { theme: PropTypes.string };",
    "",
    "  getChildContext() {",
    '    return { theme: "dark" };',
    "  }",
    "",
    "  componentDidMount() {",
    "    const node = ReactDOM.findDOMNode(this);",
    "    console.log(node);",
    "  }",
    "",
    "  render() {",
    '    return <main ref="main"><Badge /></main>;',
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/Badge.tsx": [
    'import PropTypes from "prop-types";',
    "",
    "export function Badge({ label }: { label?: string }) {",
    "  return <span>{label}</span>;",
    "}",
    "",
    'Badge.defaultProps = { label: "new" };',
    "Badge.propTypes = { label: PropTypes.string };",
    "",
  ].join("\n"),
  "src/App.test.tsx": [
    'import { act } from "react-dom/test-utils";',
    'import { render } from "@testing-library/react";',
    'import { App } from "./App";',
    "",
    'test("renders", () => {',
    "  act(() => {",
    "    render(<App />);",
    "  });",
    "});",
    "",
  ].join("\n"),
};

const LEGACY = { react: "17.0.2", reactDom: "17.0.2", testingLibrary: "12.1.5" };

function blocker(): GuidanceEntry {
  return {
    schema: "web-doctor.guidance-entry", schemaVersion: 1, id: "upgrade/react/18/testing-library", version: "1.2.0", owner: "Web Platform",
    applicability: { dependencies: [{ name: "@testing-library/react", range: "<13" }] }, evidencePrerequisites: ["static"], classification: "defect",
    explanation: "@testing-library/react before 13 renders with the React 17 root API and does not support React 18.",
    alternatives: ["Upgrade @testing-library/react to 13 or later in the same change as React 18"], tradeoffs: [],
    verification: [{ kind: "test", description: "Run the component tests on React 18." }], controls: [],
  };
}

function registryWith(guidance: GuidanceEntry[]): RegistrySnapshot {
  return { schema: "web-doctor.registry-snapshot", schemaVersion: 2, webDoctorVersion: "0.1.0", webDoctorCommit: "a".repeat(40), catalogCommit: "b".repeat(40), catalogDigest: "c".repeat(64), portals: [], contributions: [], policies: [], providers: [], guidance };
}

async function snapshotOf(files: Record<string, MemoryFile>): Promise<ProjectSnapshot> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-upgrade-")));
  temporaryDirectories.push(root);
  await materialize(root, files);
  return analyzeProject({ root, repositoryRoot: root, analyzer });
}

async function legacyApp(versions = LEGACY): Promise<ProjectSnapshot> {
  return snapshotOf({ "package.json": manifest(versions), "package-lock.json": lockfile(versions), ...SOURCES });
}

function changesOf(plan: UpgradePlan, id: string): Record<string, string[]> {
  const stage = plan.stages.find((candidate) => candidate.id === id)!;
  return Object.fromEntries(stage.changes.map((change) => [change.change, change.occurrences.map((occurrence) => `${occurrence.path}:${occurrence.line}`)]));
}

describe("React upgrade planning", () => {
  it("stages a React 17 to 19 upgrade through 18 and 18.3 with preparation first", async () => {
    const plan = planUpgrade({ snapshot: await legacyApp(), registry: registryWith([blocker()]), config: null, package: "react", target: "19" });
    expect(plan).toMatchObject({ status: "planned", target: "19.0.0", current: { version: "17.0.2", evidence: { source: "shared", category: "resolved_dependencies" } }, modifiesProject: false });
    expect(plan.stages.map((stage) => [stage.order, stage.id])).toEqual([[0, "preparation"], [1, "react-18.0.0"], [2, "react-18.3.0"], [3, "react-19.0.0"]]);

    expect(changesOf(plan, "preparation")).toEqual({
      "find-dom-node": ["src/App.tsx:14"],
      "function-default-props": ["src/Badge.tsx:7"],
      "function-prop-types": ["src/Badge.tsx:8"],
      "legacy-context": ["src/App.tsx:7", "src/App.tsx:9"],
      "string-refs": ["src/App.tsx:19"],
    });
    expect(changesOf(plan, "react-18.0.0")).toEqual({ "react-dom-render": ["src/index.tsx:4"] });
    expect(changesOf(plan, "react-18.3.0")).toEqual({ "test-utils-act": ["src/App.test.tsx:1", "src/App.test.tsx:6"] });
    expect(changesOf(plan, "react-19.0.0")).toEqual({});
    expect(plan.stages.flatMap((stage) => stage.changes).every((change) => change.detection === "automatic")).toBe(true);
    expect(plan.stages.find((stage) => stage.id === "preparation")!.rollback).toBe("Each preparation change works on react 17.0.2 and can be reverted on its own");
    expect(plan.stages.find((stage) => stage.id === "react-18.3.0")!.rollback).toBe("Land this stage's manifest, lockfile, and source changes as one change; reverting it restores react 18.0.0");
  });

  it("identifies the peer blocker before any source migration and moves lockstep packages together", async () => {
    const plan = planUpgrade({ snapshot: await legacyApp(), registry: registryWith([blocker()]), config: null, package: "react", target: "19.0.0" });
    expect(Object.keys(plan).indexOf("blockers")).toBeLessThan(Object.keys(plan).indexOf("stages"));
    expect(plan.blockers).toEqual([expect.objectContaining({
      package: "@testing-library/react",
      installed: "12.1.5",
      source: "upgrade/react/18/testing-library@1.2.0",
      stage: "react-18.0.0",
      alternatives: ["Upgrade @testing-library/react to 13 or later in the same change as React 18"],
    })]);
    expect(plan.blockers[0]!.evidence.map((view) => [view.source, view.category, view.key])).toEqual([
      ["shared", "dependencies", "package.json#devDependencies/@testing-library/react"],
      ["shared", "resolved_dependencies", "package.json#@testing-library/react"],
    ]);
    const react18 = plan.stages.find((stage) => stage.id === "react-18.0.0")!;
    expect(react18.blockedBy).toEqual(["@testing-library/react"]);
    expect(react18.dependencies.map((change) => [change.package, change.from, change.to])).toEqual([
      ["react", "17.0.2", "18.0.0"],
      ["react-dom", "17.0.2", "18.0.0"],
      ["@types/react", "17.0.80", "^18"],
    ]);
    expect(react18.verification.map((step) => [step.kind, step.command])).toEqual([
      ["install", "npm install react@18.0.0 react-dom@18.0.0"],
      ["install", "npm install --save-dev @types/react@^18"],
      ["typecheck", "npm run typecheck"],
      ["test", "npm run test"],
      ["build", "npm run build"],
    ]);
    const react183 = plan.stages.find((stage) => stage.id === "react-18.3.0")!;
    expect(react183.verification.find((step) => step.kind === "tests-for-change")).toMatchObject({ description: "Run src/App.test.tsx, which covers a changed module", evidence: { source: "extension", category: "web-doctor.tests", key: "src/App.test.tsx" } });
  });

  it("reports mismatched lockstep packages as preparation blockers", async () => {
    const plan = planUpgrade({ snapshot: await legacyApp({ ...LEGACY, reactDom: "17.0.1" }), registry: registryWith([]), config: null, package: "react", target: "18.3.1" });
    expect(plan.blockers.map((entry) => [entry.package, entry.installed, entry.stage])).toEqual([["react-dom", "17.0.1", "preparation"]]);
    expect(plan.stages[0]).toMatchObject({ id: "preparation", blockedBy: ["react-dom"] });
    expect(plan.stages.map((stage) => stage.id)).toEqual(["preparation", "react-18.0.0", "react-18.3.0", "react-18.3.1"]);
    expect(plan.stages.at(-1)!.changes).toEqual([]);
  });

  it("drops guidance blockers that the installed versions do not match", async () => {
    const plan = planUpgrade({ snapshot: await legacyApp({ ...LEGACY, testingLibrary: "13.4.0" }), registry: registryWith([blocker()]), config: null, package: "react", target: "19" });
    expect(plan.blockers).toEqual([]);
    expect(plan.stages.find((stage) => stage.id === "react-18.0.0")!.blockedBy).toEqual([]);
  });

  it("separates manual and runtime review and names dependencies nothing establishes", async () => {
    const plan = planUpgrade({ snapshot: await legacyApp(), registry: registryWith([blocker()]), config: null, package: "react", target: "19" });
    expect(plan.unestablished).toEqual(["jest", "react-redux", "typescript", "webpack"]);
    expect(plan.manual).toContain("Development StrictMode mounts, unmounts, and remounts components; confirm effects clean up after themselves");
    expect(plan.manual).toContain("React 19 requires the modern JSX transform; confirm the build compiles JSX with the automatic runtime");
    expect(plan.manual.at(-1)).toBe("Confirm that jest, react-redux, typescript, webpack support react 19.0.0; no fact or guidance establishes it");
    expect(plan.environment.packageManager).toMatchObject({ source: "shared", category: "package_managers", value: "npm" });
    expect(plan.environment.runtimes.map((view) => [view.category, view.key])).toContainEqual(["runtime_requirements", "node"]);
  });

  it("cites both provenance chains and the knowledge version", async () => {
    const snapshot = await legacyApp();
    const plan = planUpgrade({ snapshot, registry: registryWith([blocker()]), config: null, package: "react", target: "19" });
    expect(plan.provenance).toEqual({
      detectorRelease: snapshot.shared.provenance!.detectorRelease,
      configurationDigest: snapshot.shared.provenance!.configurationDigest,
      factDocumentDigest: snapshot.shared.status === "complete" ? snapshot.shared.documentDigest : null,
      extensionStateDigest: snapshot.extensions.digest,
      indexDigest: snapshot.extensions.index.digest,
      knowledge: { id: "react", version: "1.0.0", digest: knowledgeDigest(REACT_UPGRADE_KNOWLEDGE) },
    });
    expect(plan.provenance.detectorRelease).toMatch(/\S/);
    const sources = new Set(plan.stages.flatMap((stage) => [...stage.dependencies.map((change) => change.evidence?.source), ...stage.verification.map((step) => step.evidence?.source)]));
    expect([...sources].sort()).toEqual(["extension", "shared"]);
  });

  it("is unresolved rather than guessing when a version or knowledge is missing", async () => {
    const registry = registryWith([]);
    const ranged = await snapshotOf({ "package.json": manifest({ ...LEGACY, react: "^17.0.2" }), ...SOURCES });
    expect(planUpgrade({ snapshot: ranged, registry, config: null, package: "react", target: "19" })).toMatchObject({ status: "unresolved", unresolved: ["react is declared as ^17.0.2 and no lockfile fact resolves the installed version"], stages: [] });
    const snapshot = await legacyApp();
    expect(planUpgrade({ snapshot, registry, config: null, package: "react", target: "20" }).unresolved).toEqual(["Upgrade knowledge react 1.0.0 covers react up to 19"]);
    expect(planUpgrade({ snapshot, registry, config: null, package: "vue", target: "3" }).unresolved).toEqual(["Web Doctor has no upgrade knowledge for vue"]);
    expect(planUpgrade({ snapshot, registry, config: null, package: "react", target: "17.0.1" })).toMatchObject({ status: "not_needed", stages: [] });
  });

  it("never modifies the project", async () => {
    const snapshot = await legacyApp();
    const before = await fs.readFile(path.join(snapshot.root, "package-lock.json"), "utf8");
    planUpgrade({ snapshot, registry: registryWith([blocker()]), config: null, package: "react", target: "19" });
    expect(await fs.readFile(path.join(snapshot.root, "package-lock.json"), "utf8")).toBe(before);
    expect((await analyzeProject({ root: snapshot.root, repositoryRoot: snapshot.root, analyzer })).digest).toBe(snapshot.digest);
  });
});
