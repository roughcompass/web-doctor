import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  currentPolicyPack,
  digestDocument,
  parseContract,
  type Catalog,
  type Contribution,
  type ContributionFixture,
  type ContributionLock,
  type ContractKind,
  type GuidanceEntry,
  type PolicyPack,
  type PolicyPackV1,
  type ProviderManifest,
  type RegistryOwnership,
} from "../contracts/index.js";
import { APPROVAL_GATED_ENGINES, approvedReleaseFor, loadProviderApproval, rulesetProblems } from "../diagnostics/provider-approval.js";
import { guidanceProblems } from "../guidance/validation.js";
import { generateContributionLock } from "./lock.js";
import { buildRegistryProvenance, type RegistryProvenance } from "./provenance.js";
import { validateCatalog, type CatalogValidationIssue } from "./validate.js";

export interface RegistryValidationOptions {
  catalogPath: string;
  ownershipPath: string;
  lockPath: string;
  contributionsRoot: string;
}

export interface RegistryValidationReport {
  valid: boolean;
  contributions: number;
  issues: CatalogValidationIssue[];
  provenance?: RegistryProvenance;
  runtimeArtifacts: ApprovedRuntimeArtifact[];
}

export interface ApprovedRuntimeArtifact {
  contributionId: string;
  path: string;
  digest: string;
  bytes: number;
}

interface CollectedDocuments {
  guidance: GuidanceEntry[];
  policies: PolicyPack[];
}

const DOCUMENT_CONTRACT_KINDS = {
  policy: "policyPack",
  provider: "providerManifest",
  guidance: "guidanceEntry",
} as const satisfies Record<Contribution["documents"][number]["kind"], ContractKind>;

export async function validateRegistryFiles(
  options: RegistryValidationOptions,
): Promise<RegistryValidationReport> {
  const issues: CatalogValidationIssue[] = [];
  const catalog = await readContract<Catalog>("catalog", options.catalogPath, issues);
  const ownership = await readContract<RegistryOwnership>("registryOwnership", options.ownershipPath, issues);
  const lock = await readContract<ContributionLock>("contributionLock", options.lockPath, issues);
  if (catalog === undefined || ownership === undefined || lock === undefined) return finish(0, issues);

  issues.push(...validateCatalog(catalog, ownership).issues);
  const lockEntries = new Map<string, ContributionLock["contributions"][number]>();
  const runtimeArtifacts: ApprovedRuntimeArtifact[] = [];
  for (const contribution of lock.contributions) {
    if (lockEntries.has(contribution.id)) {
      add(issues, "duplicate_lock_contribution", `lock.${contribution.id}`, `Lock contains contribution ${contribution.id} more than once`);
    }
    lockEntries.set(contribution.id, contribution);
  }

  const metadata = new Map(
    lock.contributions.map((contribution) => [
      contribution.id,
      { digest: contribution.manifestDigest, contractVersion: contribution.contractVersion },
    ]),
  );
  try {
    const expected = generateContributionLock(catalog, metadata);
    if (canonicalJson(expected) !== canonicalJson(lock)) {
      add(issues, "lock_mismatch", "lock", "Contribution lock does not match the catalog and manifest metadata");
    }
  } catch (error) {
    add(issues, "lock_generation", "lock", messageFrom(error));
  }

  const documents: CollectedDocuments = { guidance: [], policies: [] };
  for (const entry of catalog.entries) {
    runtimeArtifacts.push(...await validateContribution(
      entry.id,
      entry.manifestPath,
      options.contributionsRoot,
      lockEntries.get(entry.id),
      entry,
      ownership.owners.find((owner) => owner.id === entry.owner)?.name,
      issues,
      documents,
    ));
  }
  for (const problem of guidanceProblems(documents)) {
    add(issues, `guidance_${problem.code}`, `guidance.${problem.guidance}`, problem.message);
  }

  let provenance: RegistryProvenance | undefined;
  if (issues.length === 0) {
    try {
      provenance = await buildRegistryProvenance(catalog, ownership, lock, options.contributionsRoot);
    } catch (error) {
      add(issues, "provenance", "provenance", messageFrom(error));
    }
  }

  runtimeArtifacts.sort((left, right) => `${left.contributionId}\0${left.path}`.localeCompare(`${right.contributionId}\0${right.path}`));
  return finish(catalog.entries.length, issues, provenance, runtimeArtifacts);
}

async function validateContribution(
  id: string,
  manifestPath: string,
  contributionsRoot: string,
  locked: ContributionLock["contributions"][number] | undefined,
  entry: Catalog["entries"][number],
  expectedOwnerName: string | undefined,
  issues: CatalogValidationIssue[],
  documents: CollectedDocuments,
): Promise<ApprovedRuntimeArtifact[]> {
  const root = path.resolve(contributionsRoot, ...id.split("/"));
  const manifestBuffer = await readPackageFile(root, manifestPath, `contributions.${id}.manifest`, issues);
  if (manifestBuffer === undefined) return [];

  let manifest: Contribution;
  try {
    manifest = parseContract("contribution", JSON.parse(manifestBuffer.toString("utf8")) as unknown) as Contribution;
  } catch (error) {
    add(issues, "invalid_manifest", `contributions.${id}.manifest`, messageFrom(error));
    return [];
  }
  const providerArtifacts: { path: string; digest: string }[] = [];
  const approvedArtifacts: ApprovedRuntimeArtifact[] = [];

  if (manifest.id !== entry.id || manifest.type !== entry.type || (expectedOwnerName !== undefined && manifest.owner !== expectedOwnerName)) {
    add(issues, "manifest_identity", `contributions.${id}.manifest`, `Contribution manifest identity does not match catalog entry ${id}`);
  }
  if (canonicalJson(manifest.compatibility) !== canonicalJson(entry.compatibility)) {
    add(issues, "manifest_compatibility", `contributions.${id}.manifest`, `Contribution manifest compatibility does not match catalog entry ${id}`);
  }
  if (canonicalJson(manifest.provenance) !== canonicalJson(entry.source.provenance)) {
    add(issues, "manifest_provenance", `contributions.${id}.manifest`, `Contribution manifest provenance does not match catalog entry ${id}`);
  }
  if (canonicalJson([...manifest.portals].sort()) !== canonicalJson([...entry.portals].sort()) || canonicalJson([...manifest.layers].sort()) !== canonicalJson([...entry.layers].sort())) {
    add(issues, "manifest_scope", `contributions.${id}.manifest`, `Contribution manifest portals or layers do not match catalog entry ${id}`);
  }
  if (canonicalJson([...manifest.dependencies].sort()) !== canonicalJson([...entry.dependencies].sort())) {
    add(issues, "manifest_dependencies", `contributions.${id}.manifest`, `Contribution manifest dependencies do not match catalog entry ${id}`);
  }
  if (locked === undefined) {
    add(issues, "missing_lock_contribution", `lock.${id}`, `Lock does not contain contribution ${id}`);
  } else if (digestDocument(manifest).digest !== locked.manifestDigest) {
    add(issues, "manifest_digest", `contributions.${id}.manifest`, `Contribution manifest digest does not match lock for ${id}`);
  }

  for (const document of manifest.documents) {
    const contents = await readPackageFile(root, document.path, `contributions.${id}.documents`, issues);
    if (contents === undefined) continue;
    const contractKind = DOCUMENT_CONTRACT_KINDS[document.kind];
    try {
      const parsed = parseContract(contractKind, JSON.parse(contents.toString("utf8")) as unknown);
      if (contractKind === "guidanceEntry") documents.guidance.push(parsed as GuidanceEntry);
      if (contractKind === "policyPack") documents.policies.push(currentPolicyPack(parsed as PolicyPack | PolicyPackV1));
      if (contractKind === "providerManifest") {
        const provider = parsed as ProviderManifest;
        providerArtifacts.push(...provider.artifacts);
        for (const problem of await approvalProblems(provider, root)) add(issues, "provider_approval", `contributions.${id}.documents.${document.path}`, problem);
      }
    } catch (error) {
      add(issues, "invalid_document", `contributions.${id}.documents.${document.path}`, messageFrom(error));
    }
  }

  for (const fixturePath of manifest.fixtures) {
    const contents = await readPackageFile(root, fixturePath, `contributions.${id}.fixtures`, issues);
    if (contents === undefined) continue;
    try {
      const fixture = parseContract(
        "contributionFixture",
        JSON.parse(contents.toString("utf8")) as unknown,
      ) as ContributionFixture;
      const input = await readPackageFile(root, fixture.input, `contributions.${id}.fixtures.${fixture.id}`, issues);
      if (input === undefined) continue;
      let accepted = true;
      try {
        parseContract(fixture.contract, JSON.parse(input.toString("utf8")) as unknown);
      } catch {
        accepted = false;
      }
      if ((fixture.expected === "accept") !== accepted) {
        add(issues, "fixture_expectation", `contributions.${id}.fixtures.${fixture.id}`, `Fixture ${fixture.id} expected ${fixture.expected}`);
      }
    } catch (error) {
      add(issues, "invalid_fixture", `contributions.${id}.fixtures.${fixturePath}`, messageFrom(error));
    }
  }
  const normalizedProviderArtifacts = [...providerArtifacts].sort((left, right) => left.path.localeCompare(right.path));
  const normalizedContributionArtifacts = [...manifest.runtimeArtifacts].sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(normalizedProviderArtifacts) !== canonicalJson(normalizedContributionArtifacts)) {
    add(issues, "runtime_artifact_declaration", `contributions.${id}.runtimeArtifacts`, `Provider and contribution runtime artifact declarations do not match for ${id}`);
  }
  for (const artifact of manifest.runtimeArtifacts) {
    const contents = await readPackageFile(root, artifact.path, `contributions.${id}.runtimeArtifacts`, issues);
    if (contents === undefined) continue;
    const digest = crypto.createHash("sha256").update(contents).digest("hex");
    if (digest !== artifact.digest) {
      add(issues, "artifact_digest", `contributions.${id}.runtimeArtifacts.${artifact.path}`, `Runtime artifact digest does not match for ${id}`);
    } else {
      approvedArtifacts.push({ contributionId: id, path: artifact.path, digest, bytes: contents.byteLength });
    }
  }
  return approvedArtifacts;
}

async function readContract<Value>(
  kind: ContractKind,
  filePath: string,
  issues: CatalogValidationIssue[],
): Promise<Value | undefined> {
  try {
    return parseContract(kind, JSON.parse(await fs.readFile(filePath, "utf8")) as unknown) as Value;
  } catch (error) {
    add(issues, "invalid_file", filePath, messageFrom(error));
    return undefined;
  }
}

async function readPackageFile(
  root: string,
  packagePath: string,
  issuePath: string,
  issues: CatalogValidationIssue[],
): Promise<Buffer | undefined> {
  try {
    const realRoot = await fs.realpath(root);
    const candidate = path.resolve(realRoot, ...packagePath.split("/"));
    const realCandidate = await fs.realpath(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Package path ${packagePath} escapes contribution ${root}`);
    }
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile()) throw new Error(`Package path ${packagePath} is not a regular file`);
    return await fs.readFile(realCandidate);
  } catch (error) {
    add(issues, "missing_package_file", issuePath, messageFrom(error));
    return undefined;
  }
}

function finish(
  contributions: number,
  issues: CatalogValidationIssue[],
  provenance?: RegistryProvenance,
  runtimeArtifacts: ApprovedRuntimeArtifact[] = [],
): RegistryValidationReport {
  issues.sort((left, right) =>
    `${left.code}\0${left.path}\0${left.message}`.localeCompare(`${right.code}\0${right.path}\0${right.message}`),
  );
  return {
    valid: issues.length === 0,
    contributions,
    issues,
    ...(provenance === undefined ? {} : { provenance }),
    runtimeArtifacts,
  };
}

function add(issues: CatalogValidationIssue[], code: string, issuePath: string, message: string): void {
  issues.push({ code, path: issuePath, message });
}

/**
 * A provider for an approval-gated engine, such as React Doctor, is embedded
 * only when Web Doctor's recorded approval covers its exact engine release
 * and its rule catalog matches the approved rule set.
 */
async function approvalProblems(provider: ProviderManifest, contributionRoot: string): Promise<string[]> {
  if (!APPROVAL_GATED_ENGINES.includes(provider.engine)) return [];
  const approved = approvedReleaseFor(provider, await loadProviderApproval(provider.engine));
  if ("problem" in approved) return [approved.problem];
  const catalog = provider.artifacts.find((artifact) => artifact.path.endsWith("rules.json"));
  const bytes = catalog === undefined ? null : await fs.readFile(path.join(contributionRoot, ...catalog.path.split("/"))).catch(() => null);
  return rulesetProblems(provider, approved.release, bytes);
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}