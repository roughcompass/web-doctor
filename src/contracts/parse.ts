import * as z from "zod/v4";
import { contractSchemas } from "./schemas.js";

export type ContractKind = keyof typeof contractSchemas;
export type ParsedContract = z.infer<(typeof contractSchemas)[ContractKind]>;

const SUPPORTED_VERSIONS: Readonly<Record<ContractKind, readonly number[]>> = {
  internalNpmSource: [1],
  contribution: [1],
  contributionFixture: [1],
  policyPack: [1],
  providerManifest: [1],
  catalog: [1],
  registryOwnership: [1],
  contributionLock: [1],
  registrySnapshot: [1],
  effectivePolicySnapshot: [1],
  normalizedFinding: [1],
  guidanceEntry: [1],
  mcpResponse: [1],
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

export function parseContract(kind: ContractKind, input: unknown): ParsedContract {
  const version = readSchemaVersion(input);
  const supportedVersions = SUPPORTED_VERSIONS[kind];

  if (version !== undefined && !supportedVersions.includes(version)) {
    throw new UnsupportedSchemaVersionError(kind, version, supportedVersions);
  }

  return contractSchemas[kind].parse(input) as ParsedContract;
}

export function supportedSchemaVersions(kind: ContractKind): readonly number[] {
  return SUPPORTED_VERSIONS[kind];
}

function readSchemaVersion(input: unknown): number | undefined {
  if (typeof input !== "object" || input === null || !("schemaVersion" in input)) return undefined;
  const version = input.schemaVersion;
  return typeof version === "number" ? version : undefined;
}