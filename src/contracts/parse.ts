import * as z from "zod/v4";
import { contractSchemas, previousContractSchemas, type PolicyPack, type PolicyPackV1 } from "./schemas.js";

export type ContractKind = keyof typeof contractSchemas;
export type ParsedContract = z.infer<(typeof contractSchemas)[ContractKind]>;

const SUPPORTED_VERSIONS: Readonly<Record<ContractKind, readonly number[]>> = {
  internalNpmSource: [1],
  contribution: [1],
  contributionFixture: [1],
  policyPack: [1, 2],
  providerManifest: [1],
  catalog: [1],
  registryOwnership: [1],
  contributionLock: [1],
  registrySnapshot: [2],
  effectivePolicySnapshot: [3],
  normalizedFinding: [2],
  guidanceEntry: [1],
  mcpResponse: [2],
  repoFactsRelease: [1],
  repositoryConfig: [1],
  diagnosticsReport: [1],
  profileEvidence: [1],
  providerApproval: [1],
};

export class UnsupportedSchemaVersionError extends Error {
  override readonly name = "UnsupportedSchemaVersionError";

  constructor(
    readonly kind: ContractKind,
    readonly receivedVersion: number,
    readonly supportedVersions: readonly number[],
  ) {
    super(
      `Unsupported ${kind} schema version ${receivedVersion}; supported versions: ${supportedVersions.join(", ")}`,
    );
  }
}

/**
 * Parses a document with the schema of its own version. An earlier supported
 * version is validated as that version and returned unchanged; callers that
 * need the current shape migrate it explicitly, as `currentPolicyPack` does.
 */
export function parseContract(kind: ContractKind, input: unknown): ParsedContract {
  const version = readSchemaVersion(input);
  const supportedVersions = SUPPORTED_VERSIONS[kind];

  if (version !== undefined && !supportedVersions.includes(version)) {
    throw new UnsupportedSchemaVersionError(kind, version, supportedVersions);
  }

  return schemaFor(kind, version).parse(input) as ParsedContract;
}

export function supportedSchemaVersions(kind: ContractKind): readonly number[] {
  return SUPPORTED_VERSIONS[kind];
}

/** The schema for one supported version of a document kind. */
export function schemaFor(kind: ContractKind, version: number | undefined): z.ZodType {
  const previous = (previousContractSchemas as Partial<Record<ContractKind, Readonly<Record<number, z.ZodType>>>>)[kind];
  return (version === undefined ? undefined : previous?.[version]) ?? contractSchemas[kind];
}

/** Reads a version 1 policy pack as version 2: version 1 Controls are version 2 Controls without approved patterns. */
export function currentPolicyPack(pack: PolicyPack | PolicyPackV1): PolicyPack {
  return pack.schemaVersion === 2 ? pack : { ...pack, schemaVersion: 2 };
}

/** Parses a policy pack of any supported version and returns it in the current version. */
export function parsePolicyPack(input: unknown): PolicyPack {
  return currentPolicyPack(parseContract("policyPack", input) as PolicyPack | PolicyPackV1);
}

function readSchemaVersion(input: unknown): number | undefined {
  if (typeof input !== "object" || input === null || !("schemaVersion" in input)) return undefined;
  const version = input.schemaVersion;
  return typeof version === "number" ? version : undefined;
}
