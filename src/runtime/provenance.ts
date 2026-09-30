import fs from "node:fs/promises";
import process from "node:process";
import { digestDocument, parseContract, type RegistrySnapshot } from "../contracts/index.js";
import { WEB_DOCTOR_VERSION } from "../version.js";

export interface RuntimeContributionProvenance {
  id: string;
  type: RegistrySnapshot["contributions"][number]["type"];
  packageName: string;
  version: string;
  integrity: string;
  repository: string;
  commit: string;
  manifestDigest: string;
}

export interface BuildProvenance {
  webDoctorVersion: string;
  webDoctorCommit: string;
  catalogCommit: string;
  registryDigest: string;
  catalogDigest: string;
  contributions: RuntimeContributionProvenance[];
}

export interface BuildProvenanceOptions {
  snapshotPath?: string;
}

export async function loadBuildProvenance(
  options: BuildProvenanceOptions = {},
): Promise<BuildProvenance> {
  const snapshotUrl = new URL("../../generated/registry/snapshot.json", import.meta.url);
  const snapshotPath = options.snapshotPath ?? process.env.WEB_DOCTOR_REGISTRY_SNAPSHOT ?? snapshotUrl;
  const text = await fs.readFile(snapshotPath, "utf8");
  const snapshot = parseContract("registrySnapshot", JSON.parse(text) as unknown) as RegistrySnapshot;
  return buildBuildProvenance(snapshot);
}

export function buildBuildProvenance(snapshot: RegistrySnapshot): BuildProvenance {
  if (snapshot.webDoctorVersion !== WEB_DOCTOR_VERSION) {
    throw new Error(`Registry snapshot targets Web Doctor ${snapshot.webDoctorVersion}, installed ${WEB_DOCTOR_VERSION}`);
  }

  return {
    webDoctorVersion: snapshot.webDoctorVersion,
    webDoctorCommit: snapshot.webDoctorCommit,
    catalogCommit: snapshot.catalogCommit,
    registryDigest: digestDocument(snapshot).digest,
    catalogDigest: snapshot.catalogDigest,
    contributions: snapshot.contributions.map((contribution) => ({
      id: contribution.id,
      type: contribution.type,
      packageName: contribution.source.packageName,
      version: contribution.source.version,
      integrity: contribution.source.integrity,
      repository: contribution.source.provenance.repository,
      commit: contribution.source.provenance.commit,
      manifestDigest: contribution.manifestDigest,
    })),
  };
}