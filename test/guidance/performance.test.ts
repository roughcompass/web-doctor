import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuidanceEntry, ProfileEvidence, RegistrySnapshot } from "../../src/contracts/index.js";
import { buildProjectIndex, type ProjectIndex } from "../../src/facts/project-index.js";
import { analyzeProject } from "../../src/facts/project-snapshot.js";
import { recordRepoFactsRelease } from "../../src/facts/repo-facts-release.js";
import { SharedFactsAnalyzer } from "../../src/facts/shared-facts.js";
import { WorkingTreeListing } from "../../src/facts/working-tree-reader.js";
import { analyzePerformance } from "../../src/guidance/performance.js";
import { selectGuidance } from "../../src/guidance/selection.js";
import { createEffectivePolicySnapshot } from "../../src/runtime/effective-policy.js";
import { composePolicy } from "../../src/runtime/policy-composition.js";
import { materialize } from "../support/repo-facts-fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
let workspace: string;
let index: ProjectIndex;

const FILES = {
  "package.json": '{"name":"orders","dependencies":{"react":"18.3.1"}}\n',
  "src/OrderRow.tsx": [
    'import { memo } from "react";',
    "",
    "export const OrderRow = memo(function OrderRow({ id, onSelect, style }: { id: string; onSelect: () => void; style: object }) {",
    "  return <li style={style} onClick={onSelect}>{id}</li>;",
    "});",
    "",
  ].join("\n"),
  "src/Header.tsx": "export function Header({ onRefresh }: { onRefresh: () => void }) {\n  return <button onClick={onRefresh}>Refresh</button>;\n}\n",
  "src/OrderList.tsx": [
    'import { OrderRow } from "./OrderRow";',
    'import { Header } from "./Header";',
    "",
    "export function OrderList({ ids, select }: { ids: string[]; select: (id: string) => void }) {",
    "  return (",
    "    <section>",
    "      <Header onRefresh={() => select(\"\")} />",
    "      <button onClick={() => select(\"all\")}>All</button>",
    "      <ul>{ids.map((id) => <OrderRow key={id} id={id} onSelect={() => select(id)} style={{ padding: 4 }} />)}</ul>",
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n"),
};

const PROFILE: ProfileEvidence = {
  schema: "web-doctor.profile-evidence",
  schemaVersion: 1,
  interaction: "Select an order row",
  source: "React Developer Tools Profiler export",
  commitBudgetMs: 16,
  components: [
    { component: "OrderRow", commits: 40, actualDurationMs: 520, maxCommitMs: 24 },
    { component: "src/OrderList.tsx#OrderList", commits: 40, actualDurationMs: 80, maxCommitMs: 4 },
    { component: "LegacyTable", commits: 3, actualDurationMs: 90, maxCommitMs: 30 },
  ],
};

beforeAll(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-performance-")));
  await materialize(workspace, FILES);
  index = await buildProjectIndex((await WorkingTreeListing.scan({ root: workspace })).open());
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("performance evidence levels", () => {
  it("classifies memo-defeating props as static risks and other inline props as needing measurement", () => {
    const { observations, unmatched } = analyzePerformance(index);
    expect(observations.map((item) => [item.kind, item.element?.name, item.attribute, item.propKind, item.classification])).toEqual([
      ["inline-prop", "Header", "onRefresh", "function", "measurement_required"],
      ["inline-prop", "OrderRow", "onSelect", "function", "risk"],
      ["inline-prop", "OrderRow", "style", "object", "risk"],
    ]);
    expect(unmatched).toEqual([]);
    expect(observations.find((item) => item.attribute === "onRefresh")!.recommendation).toBe("Do not add memoization for this alone; measure the interaction first and change it only if Header shows up as a cost");
    expect(observations.find((item) => item.attribute === "onSelect")!.reasoning).toContain("how much that costs is not measured");
  });

  it("never claims a defect or an improvement without profile evidence", () => {
    const { observations } = analyzePerformance(index);
    expect(observations.some((item) => item.classification === "defect")).toBe(false);
    for (const item of observations) {
      expect(item.measurement).toBeNull();
      expect(item.improvement).toBeNull();
      expect(item.verification[0]!.kind).toBe("profile");
      expect(`${item.reasoning} ${item.recommendation}`.toLowerCase()).not.toMatch(/\bwill (improve|speed|reduce)\b|\bfaster\b/);
    }
  });

  it("relates a measured hotspot to its symbol and asks to re-measure the same interaction", () => {
    const { observations, unmatched } = analyzePerformance(index, PROFILE);
    const hotspot = observations.find((item) => item.kind === "hotspot")!;
    expect(hotspot).toMatchObject({ classification: "defect", symbol: "src/OrderRow.tsx#OrderRow", measurement: { interaction: "Select an order row", maxCommitMs: 24, budgetMs: 16 }, improvement: null });
    expect(hotspot.verification).toEqual([{ kind: "profile", description: 'Profile "Select an order row" again after any change and compare commit durations for the same components' }]);
    expect(observations.filter((item) => item.kind === "hotspot")).toHaveLength(1);
    expect(observations.find((item) => item.attribute === "onSelect")).toMatchObject({ classification: "risk", measurement: { component: "OrderRow" } });
    expect(unmatched).toEqual(["LegacyTable"]);
  });

  it("keeps measurement-dependent registry guidance at measurement required until a measurement exists", async () => {
    const guidance: GuidanceEntry = {
      schema: "web-doctor.guidance-entry", schemaVersion: 1, id: "react/performance/expensive-render", version: "1.0.0", owner: "Web Platform",
      applicability: { capabilities: [{ name: "react" }] }, evidencePrerequisites: ["measured"], classification: "defect",
      explanation: "A component that exceeds the commit budget in a common interaction slows the page.",
      alternatives: ["Split the component", "Virtualize long lists"], tradeoffs: ["Splitting adds indirection"],
      verification: [{ kind: "profile", description: "Profile the interaction again." }], controls: [],
    };
    const registry: RegistrySnapshot = { schema: "web-doctor.registry-snapshot", schemaVersion: 2, webDoctorVersion: "0.1.0", webDoctorCommit: "a".repeat(40), catalogCommit: "b".repeat(40), catalogDigest: "c".repeat(64), portals: [], contributions: [], policies: [], providers: [], guidance: [guidance] };
    const analyzer = await SharedFactsAnalyzer.create({ release: await recordRepoFactsRelease({ root: ROOT }) });
    const snapshot = await analyzeProject({ root: workspace, analyzer });
    const policy = createEffectivePolicySnapshot({ composition: composePolicy({ registry }) });
    const [unmeasured] = selectGuidance({ registry, snapshot, policy, config: null });
    const [measured] = selectGuidance({ registry, snapshot, policy, config: null, measured: true });
    expect(unmeasured).toMatchObject({ status: "applicable", classification: "defect", effectiveClassification: "measurement_required" });
    expect(measured!.effectiveClassification).toBe("defect");
  });
});
