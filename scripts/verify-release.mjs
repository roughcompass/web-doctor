import process from "node:process";
import { verifyRegistryReleaseArtifacts, WEB_DOCTOR_VERSION } from "../dist/index.js";

const registry = required("WEB_DOCTOR_NPM_REGISTRY");
const webDoctorCommit = required("WEB_DOCTOR_COMMIT");
const catalogCommit = required("WEB_DOCTOR_CATALOG_COMMIT");
const result = await verifyRegistryReleaseArtifacts({
  catalogPath: "registry/catalog.json",
  ownershipPath: "registry/ownership.json",
  lockPath: "registry/registry.lock.json",
  generatedRoot: "generated/registry",
  resolver: { registry },
  webDoctorVersion: WEB_DOCTOR_VERSION,
  webDoctorCommit,
  catalogCommit,
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}