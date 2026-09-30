import process from "node:process";
import { validateRegistryPullRequest } from "../dist/index.js";

const registry = process.env.WEB_DOCTOR_NPM_REGISTRY;
if (!registry) throw new Error("WEB_DOCTOR_NPM_REGISTRY is required");

const report = await validateRegistryPullRequest({
  catalogPath: "registry/catalog.json",
  ownershipPath: "registry/ownership.json",
  lockPath: "registry/registry.lock.json",
  resolver: { registry },
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.valid) process.exitCode = 2;