import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  parseContract,
  sha256,
  type Catalog,
} from "../../src/contracts/index.js";
import {
  generateContributionLock,
  writeContributionLock,
  type ContributionManifestMetadata,
} from "../../src/registry/lock.js";

const temporaryDirectories: string[] = [];
const catalog = parseContract(
  "catalog",
  JSON.parse(
    await fs.readFile(new URL("../../registry/catalog.json", import.meta.url), "utf8"),
  ) as unknown,
) as Catalog;
const manifests = new Map<string, ContributionManifestMetadata>(
  catalog.entries.map((entry) => [entry.id, { digest: sha256(entry.id), contractVersion: 1 }]),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("contribution lock", () => {
  it("resolves transitive dependencies and normalizes contribution ordering", () => {
    const lock = generateContributionLock(catalog, manifests);
    const advisor = lock.contributions.find((entry) => entry.id === "advisor/content");

    expect(advisor?.resolvedDependencies).toEqual(["firm/accessibility"]);
    expect(lock.contributions.map((entry) => entry.id)).toEqual(
      [...catalog.entries.map((entry) => entry.id)].sort(),
    );
    expect(lock.contributions.every((entry) => entry.contractVersion === 1)).toBe(true);
  });

  it("produces byte-identical locks for semantically identical catalog ordering", () => {
    const reordered: Catalog = {
      ...catalog,
      portals: [...catalog.portals].reverse(),
      entries: [...catalog.entries]
        .reverse()
        .map((entry) => ({ ...entry, portals: [...entry.portals].reverse(), dependencies: [...entry.dependencies].reverse() })),
    };

    expect(canonicalJson(generateContributionLock(reordered, manifests))).toBe(
      canonicalJson(generateContributionLock(catalog, manifests)),
    );
  });

  it("writes canonical registry.lock.json bytes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-lock-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "registry.lock.json");
    const lock = generateContributionLock(catalog, manifests);

    await writeContributionLock(outputPath, lock);

    expect(await fs.readFile(outputPath, "utf8")).toBe(`${canonicalJson(lock)}\n`);
  });

  it("rejects missing manifest metadata, missing dependencies, and cycles", () => {
    expect(() => generateContributionLock(catalog, new Map())).toThrow(/Missing manifest metadata/);

    const missingDependency: Catalog = {
      ...catalog,
      entries: catalog.entries.map((entry) =>
        entry.id === "firm/accessibility" ? { ...entry, dependencies: ["missing/policy"] } : entry,
      ),
    };
    expect(() => generateContributionLock(missingDependency, manifests)).toThrow(/Missing contribution/);

    const cyclic: Catalog = {
      ...catalog,
      entries: catalog.entries.map((entry) => {
        if (entry.id === "firm/accessibility") return { ...entry, dependencies: ["advisor/content"] };
        return entry;
      }),
    };
    expect(() => generateContributionLock(cyclic, manifests)).toThrow(/dependency cycle/);
  });
});