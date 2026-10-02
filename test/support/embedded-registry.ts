import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  digestDocument,
  type Contribution,
  type GuidanceEntry,
  type PolicyPack,
  type ProviderManifest,
  type RegistrySnapshot,
} from "../../src/contracts/index.js";
import { assembleEmbeddedRegistry } from "../../src/registry/assemble.js";
import { WEB_DOCTOR_VERSION } from "../../src/version.js";

/**
 * Assembles a verified embedded registry, as a release would, from policy
 * packs, provider manifests with runtime artifacts, and guidance entries.
 * Each document becomes one contribution with a manifest, an accepting
 * fixture, and exact package provenance.
 */

export interface ProviderFixture {
  manifest: ProviderManifest;
  artifacts: Readonly<Record<string, string>>;
}

export interface EmbeddedRegistryFixture {
  policies?: readonly PolicyPack[];
  providers?: readonly ProviderFixture[];
  guidance?: readonly GuidanceEntry[];
  portals?: RegistrySnapshot["portals"];
}

export async function writeEmbeddedRegistry(root: string, fixture: EmbeddedRegistryFixture): Promise<{ root: string; snapshot: RegistrySnapshot }> {
  const staged = path.join(root, "staged");
  const contributions: RegistrySnapshot["contributions"] = [];
  const stage = async (
    id: string,
    type: Contribution["type"],
    document: { kind: Contribution["documents"][number]["kind"]; content: object; contract: "policyPack" | "providerManifest" | "guidanceEntry" },
    options: { layers: Contribution["layers"]; portals: string[]; artifacts?: Readonly<Record<string, string>> },
  ) => {
    const directory = path.join(staged, ...id.split("/"));
    await fs.mkdir(path.join(directory, "fixtures"), { recursive: true });
    const runtimeArtifacts = [];
    for (const [artifact, content] of Object.entries(options.artifacts ?? {})) {
      await fs.mkdir(path.dirname(path.join(directory, artifact)), { recursive: true });
      await fs.writeFile(path.join(directory, artifact), content);
      runtimeArtifacts.push({ path: artifact, digest: crypto.createHash("sha256").update(content).digest("hex") });
    }
    const manifest: Contribution = {
      schema: "web-doctor.contribution",
      schemaVersion: 1,
      id,
      type,
      owner: "Fixture Team",
      compatibility: { webDoctor: ">=0.1.0" },
      portals: options.portals,
      layers: options.layers,
      documents: [{ kind: document.kind, path: "document.json" }],
      runtimeArtifacts,
      dependencies: [],
      fixtures: ["fixtures/accept.json"],
      provenance: { repository: `ssh://git.internal/${id}.git`, commit: "c".repeat(40) },
    };
    await fs.writeFile(path.join(directory, "web-doctor.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(directory, "document.json"), JSON.stringify(document.content));
    await fs.writeFile(path.join(directory, "fixtures", "accept.json"), JSON.stringify({ schema: "web-doctor.fixture", schemaVersion: 1, id: "accept", contract: document.contract, input: "document.json", expected: "accept" }));
    contributions.push({
      id,
      type,
      owner: "fixture-team",
      source: {
        schema: "web-doctor.npm-source",
        schemaVersion: 1,
        registry: "internal",
        packageName: `@fixture/${id.replaceAll("/", "-")}`,
        version: "1.0.0",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        provenance: manifest.provenance,
      },
      manifestPath: "web-doctor.json",
      manifestDigest: digestDocument(manifest).digest,
      lifecycle: "active",
      compatibility: manifest.compatibility,
      portals: [...options.portals].sort(),
      layers: [...options.layers].sort(),
    });
  };
  for (const policy of fixture.policies ?? []) {
    const portals = [...new Set(policy.controls.flatMap((control) => control.applicability.portals?.anyOf ?? []))];
    await stage(policy.id, "policy", { kind: "policy", content: policy, contract: "policyPack" }, { layers: [policy.layer], portals: policy.layer === "portal" ? portals : [] });
  }
  for (const provider of fixture.providers ?? []) {
    await stage(provider.manifest.id, "provider", { kind: "provider", content: provider.manifest, contract: "providerManifest" }, { layers: [], portals: [], artifacts: provider.artifacts });
  }
  for (const entry of fixture.guidance ?? []) {
    await stage(entry.id, "guidance", { kind: "guidance", content: entry, contract: "guidanceEntry" }, { layers: [], portals: [] });
  }
  const snapshot: RegistrySnapshot = {
    schema: "web-doctor.registry-snapshot",
    schemaVersion: 2,
    webDoctorVersion: WEB_DOCTOR_VERSION,
    webDoctorCommit: "a".repeat(40),
    catalogCommit: "b".repeat(40),
    catalogDigest: "d".repeat(64),
    portals: [...(fixture.portals ?? [{ id: "advisor", lifecycle: "active" }, { id: "wealth", lifecycle: "active" }])].sort((left, right) => left.id.localeCompare(right.id)),
    contributions: contributions.sort((left, right) => left.id.localeCompare(right.id)),
    policies: sortById(fixture.policies ?? []),
    providers: sortById((fixture.providers ?? []).map((provider) => provider.manifest)),
    guidance: sortById(fixture.guidance ?? []),
  };
  const generated = path.join(root, "generated", "registry");
  await assembleEmbeddedRegistry(snapshot, staged, generated);
  return { root: generated, snapshot };
}

function sortById<Document extends { id: string; version: string }>(documents: readonly Document[]): Document[] {
  return [...documents].sort((left, right) => `${left.id}\0${left.version}`.localeCompare(`${right.id}\0${right.version}`));
}
