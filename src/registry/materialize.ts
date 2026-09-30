import fs from "node:fs/promises";
import path from "node:path";
import {
  digestDocument,
  parseContract,
  type Catalog,
  type Contribution,
  type ContributionFixture,
} from "../contracts/index.js";
import type { ContributionManifestMetadata } from "./lock.js";
import {
  readInternalNpmArtifact,
  type NpmArtifactResolverOptions,
} from "./npm-artifact.js";

export async function materializeCatalogContributions(
  catalog: Catalog,
  outputRoot: string,
  resolverOptions: NpmArtifactResolverOptions,
): Promise<ReadonlyMap<string, ContributionManifestMetadata>> {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });
  const metadata = new Map<string, ContributionManifestMetadata>();

  for (const entry of catalog.entries) {
    const manifestArtifact = await readInternalNpmArtifact(
      entry.source,
      [entry.manifestPath],
      resolverOptions,
    );
    const manifest = parseContract(
      "contribution",
      JSON.parse(manifestArtifact.files.get(entry.manifestPath)!.toString("utf8")) as unknown,
    ) as Contribution;
    const fixtureArtifact = await readInternalNpmArtifact(
      entry.source,
      [entry.manifestPath, ...manifest.fixtures],
      resolverOptions,
    );
    const fixtureInputs = manifest.fixtures.map((fixturePath) => {
      const fixture = parseContract(
        "contributionFixture",
        JSON.parse(fixtureArtifact.files.get(fixturePath)!.toString("utf8")) as unknown,
      ) as ContributionFixture;
      return fixture.input;
    });
    const requestedPaths = [
      entry.manifestPath,
      ...manifest.documents.map((document) => document.path),
      ...manifest.fixtures,
      ...fixtureInputs,
      ...manifest.runtimeArtifacts.map((artifact) => artifact.path),
    ];
    const artifact = await readInternalNpmArtifact(entry.source, requestedPaths, resolverOptions);
    const contributionRoot = path.join(outputRoot, ...entry.id.split("/"));

    for (const [packagePath, contents] of artifact.files) {
      const destination = path.join(contributionRoot, ...packagePath.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, contents);
    }
    metadata.set(entry.id, {
      digest: digestDocument(manifest).digest,
      contractVersion: manifest.schemaVersion,
    });
  }

  return metadata;
}