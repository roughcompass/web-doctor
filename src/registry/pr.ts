import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  parseContract,
  type Catalog,
} from "../contracts/index.js";
import { validateRegistryFiles, type RegistryValidationReport } from "./command.js";
import { generateContributionLock, writeContributionLock } from "./lock.js";
import { materializeCatalogContributions } from "./materialize.js";
import type { NpmArtifactResolverOptions } from "./npm-artifact.js";

export interface PullRequestValidationOptions {
  catalogPath: string;
  ownershipPath: string;
  lockPath: string;
  resolver: NpmArtifactResolverOptions;
}

export async function validateRegistryPullRequest(
  options: PullRequestValidationOptions,
): Promise<RegistryValidationReport> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-pr-"));
  const contributionsRoot = path.join(workspace, "contributions");
  const generatedLockPath = path.join(workspace, "registry.lock.json");

  try {
    const catalog = parseContract(
      "catalog",
      JSON.parse(await fs.readFile(options.catalogPath, "utf8")) as unknown,
    ) as Catalog;
    const metadata = await materializeCatalogContributions(
      catalog,
      contributionsRoot,
      options.resolver,
    );
    const generatedLock = generateContributionLock(catalog, metadata);
    await writeContributionLock(generatedLockPath, generatedLock);
    const report = await validateRegistryFiles({
      catalogPath: options.catalogPath,
      ownershipPath: options.ownershipPath,
      lockPath: options.lockPath,
      contributionsRoot,
    });

    let lockMatches = false;
    try {
      const checkedIn = parseContract(
        "contributionLock",
        JSON.parse(await fs.readFile(options.lockPath, "utf8")) as unknown,
      );
      lockMatches = canonicalJson(checkedIn) === canonicalJson(generatedLock);
    } catch {
      lockMatches = false;
    }
    if (lockMatches) return report;

    const issues = [
      ...report.issues,
      { code: "lock_diff", path: options.lockPath, message: "Checked-in contribution lock differs from generated output" },
    ].sort((left, right) =>
      `${left.code}\0${left.path}\0${left.message}`.localeCompare(`${right.code}\0${right.path}\0${right.message}`),
    );
    return { ...report, valid: false, issues };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}