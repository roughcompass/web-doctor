import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestDocument, parseContract, type Catalog, type GuidanceEntry } from "../../src/contracts/index.js";
import { GuidanceValidationError, guidanceProblems } from "../../src/guidance/validation.js";
import { generateContributionLock } from "../../src/registry/lock.js";
import { compileRegistrySnapshot } from "../../src/registry/snapshot.js";
import { loadEmbeddedRegistry } from "../../src/runtime/embedded-registry.js";
import { representativePolicyPacks } from "../fixtures/policies.js";
import { writeEmbeddedRegistry } from "../support/embedded-registry.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function entry(overrides: Partial<GuidanceEntry>): GuidanceEntry {
  return {
    schema: "web-doctor.guidance-entry",
    schemaVersion: 1,
    id: "react/performance/inline-callback",
    version: "1.0.0",
    owner: "Web Platform",
    applicability: { capabilities: [{ name: "react", range: ">=16.8" }] },
    evidencePrerequisites: ["static"],
    classification: "risk",
    explanation: "An inline callback creates a new function each render.",
    alternatives: ["Move the callback out of render."],
    tradeoffs: ["Memoization adds its own cost."],
    verification: [{ kind: "profile", description: "Profile the interaction before and after." }],
    controls: [],
    ...overrides,
  };
}

describe("guidance validation", () => {
  it("accepts the guidance Web Doctor ships and documents", async () => {
    const shipped = await Promise.all((await fs.readdir(path.join(ROOT, "examples", "axe-provider", "guidance"))).map(async (file) => JSON.parse(await fs.readFile(path.join(ROOT, "examples", "axe-provider", "guidance", file), "utf8")) as GuidanceEntry));
    const example = JSON.parse(await fs.readFile(path.join(ROOT, "examples", "contracts", "guidance-entry.json"), "utf8")) as GuidanceEntry;
    expect(guidanceProblems({ guidance: [...shipped, example, entry({})], policies: representativePolicyPacks })).toEqual([]);
  });

  it("rejects unsupported, contradictory, and unresolved guidance", () => {
    const problems = guidanceProblems({
      policies: representativePolicyPacks,
      guidance: [
        entry({ id: "a/duplicate" }),
        entry({ id: "a/duplicate" }),
        entry({ id: "b/manual-defect", classification: "defect", evidencePrerequisites: ["manual"] }),
        entry({ id: "c/unmeasured", classification: "measurement_required", verification: [{ kind: "test", description: "Run tests." }] }),
        entry({ id: "d/unknown-control", controls: ["firm/accessibility/button-name", "firm/missing/control"] }),
        entry({ id: "e/bad-range", applicability: { dependencies: [{ name: "react", range: "not a range" }] } }),
        entry({ id: "f/disjoint", applicability: { capabilities: [{ name: "react", range: ">=19" }, { name: "react", range: "<18" }] } }),
        entry({ id: "g/excluded", applicability: { files: { include: ["src/**"], exclude: ["src/**"] } } }),
      ],
    });
    expect(problems.map((problem) => `${problem.guidance} ${problem.code}`)).toEqual([
      "a/duplicate duplicate_guidance",
      "b/manual-defect unsupported_evidence",
      "c/unmeasured missing_measurement",
      "d/unknown-control unknown_control",
      "e/bad-range invalid_range",
      "f/disjoint never_applies",
      "g/excluded never_applies",
    ]);
    expect(problems.find((problem) => problem.code === "unknown_control")!.message).toBe("References Control firm/missing/control, which no policy defines");
  });

  it("keeps contradictory guidance out of a compiled snapshot", async () => {
    const root = await temporary();
    const contribution = {
      schema: "web-doctor.contribution",
      schemaVersion: 1,
      id: "firm/guidance",
      type: "guidance",
      owner: "Web Platform",
      compatibility: { webDoctor: ">=0.1.0" },
      portals: [],
      layers: ["firmwide"],
      documents: [{ kind: "guidance", path: "guidance.json" }],
      runtimeArtifacts: [],
      dependencies: [],
      fixtures: ["fixture.json"],
      provenance: { repository: "ssh://git.internal/firm/guidance.git", commit: "a".repeat(40) },
    };
    const directory = path.join(root, "firm", "guidance");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "web-doctor.json"), JSON.stringify(contribution));
    await fs.writeFile(path.join(directory, "guidance.json"), JSON.stringify(entry({ classification: "defect", evidencePrerequisites: ["manual"] })));
    await fs.writeFile(path.join(directory, "fixture.json"), JSON.stringify({ schema: "web-doctor.fixture", schemaVersion: 1, id: "accept", contract: "guidanceEntry", input: "guidance.json", expected: "accept" }));
    const catalog = parseContract("catalog", {
      schema: "web-doctor.catalog",
      schemaVersion: 1,
      portals: [],
      entries: [{
        id: "firm/guidance",
        type: "guidance",
        owner: "web-platform",
        source: { schema: "web-doctor.npm-source", schemaVersion: 1, registry: "internal", packageName: "@firm/guidance", version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, provenance: contribution.provenance },
        manifestPath: "web-doctor.json",
        portals: [],
        layers: ["firmwide"],
        compatibility: { webDoctor: ">=0.1.0" },
        lifecycle: "active",
        dependencies: [],
      }],
    }) as Catalog;
    const lock = generateContributionLock(catalog, new Map([["firm/guidance", { digest: digestDocument(contribution).digest, contractVersion: 1 }]]));
    await expect(compileRegistrySnapshot({ catalog, lock, contributionsRoot: root, webDoctorVersion: "0.1.0", webDoctorCommit: "b".repeat(40), catalogCommit: "c".repeat(40) })).rejects.toThrow(GuidanceValidationError);
  });

  it("refuses to load an embedded registry carrying contradictory guidance", async () => {
    const root = await temporary();
    const registry = await writeEmbeddedRegistry(root, { policies: representativePolicyPacks, guidance: [entry({ controls: ["firm/missing/control"] })] });
    await expect(loadEmbeddedRegistry({ root: registry.root })).rejects.toThrow("References Control firm/missing/control, which no policy defines");
  });
});

async function temporary(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-guidance-")));
  temporaryDirectories.push(directory);
  return directory;
}
