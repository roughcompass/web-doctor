import { DETECTOR_RELEASE, analyze, detectorConfiguration } from "@repo-facts/bundle";
import {
  type Budgets,
  FACT_DOCUMENT_SCHEMA,
  FACT_DOCUMENT_VERSION,
  type FactDocument,
  type JsonValue,
  SKIPPED_INPUT_REASONS,
  type SourceReader,
  compareCodeUnits,
  digestOf,
  factDocumentProblems,
  freeze,
} from "@repo-facts/contract";
import type { RepoFactsRelease } from "../contracts/index.js";
import { loadRepoFactsRelease, verifyInstalledRepoFacts } from "./repo-facts-release.js";

/**
 * Runs the pinned repo-facts detector release through a SourceReader and
 * keeps its fact document exactly as produced. Web Doctor never repairs,
 * reinterprets, or replaces shared facts: an unavailable release, a
 * nonconforming reader, an unsupported schema, or an invalid document makes
 * shared context incomplete, and nothing falls back to another detector.
 */

export const SUPPORTED_FACT_DOCUMENT_VERSIONS: readonly number[] = [FACT_DOCUMENT_VERSION];

export type SharedFactsIncompleteReason =
  | "release_unavailable"
  | "nonconforming_reader"
  | "unsupported_schema"
  | "invalid_document"
  | "invalid_digest"
  | "analysis_failed";

export interface SharedFactsProvenance {
  detectorRelease: string;
  sourceCommit: string;
  configurationDigest: string;
  parser: { name: string; version: string; maxNodes: number; maxDepth: number };
  limits: Budgets;
  packages: { name: string; version: string; integrity: string }[];
}

export interface SkippedInput {
  path: string;
  reason: string;
  detail: string;
  /** The detector that could not use the input, or null when the reader refused it. */
  detector: string | null;
}

export interface SharedFactsComplete {
  status: "complete";
  document: FactDocument;
  documentDigest: string;
  provenance: SharedFactsProvenance;
  diagnostics: FactDocument["diagnostics"];
  skippedInputs: SkippedInput[];
  /** Categories whose search was incomplete or skipped an input. */
  incompleteCategories: string[];
  usage: { files: number; bytes: number };
}

export interface SharedFactsIncomplete {
  status: "incomplete";
  reason: SharedFactsIncompleteReason;
  problems: string[];
  provenance?: SharedFactsProvenance;
}

export type SharedFactsResult = SharedFactsComplete | SharedFactsIncomplete;

export type SharedFactsAvailability =
  | { status: "available"; release: RepoFactsRelease }
  | { status: "unavailable"; problems: string[] };

export interface SharedFactsAnalyzerOptions {
  /** Build metadata to verify against; loaded from generated/repo-facts.json by default. */
  release?: RepoFactsRelease;
  metadataPath?: string;
  /** Module location that resolves the installed packages; defaults to Web Doctor's own. */
  resolveFrom?: string;
}

export class SharedFactsAnalyzer {
  private constructor(readonly availability: SharedFactsAvailability) {}

  /** Verifies the pinned release once per process, before any analysis. */
  static async create(options: SharedFactsAnalyzerOptions = {}): Promise<SharedFactsAnalyzer> {
    let release: RepoFactsRelease;
    try {
      release = options.release ?? await loadRepoFactsRelease(options.metadataPath);
    } catch (error) {
      return new SharedFactsAnalyzer({ status: "unavailable", problems: [`The recorded repo-facts release cannot be loaded: ${messageOf(error)}`] });
    }
    if (release.release !== DETECTOR_RELEASE) {
      return new SharedFactsAnalyzer({ status: "unavailable", problems: [`The loaded detector release ${DETECTOR_RELEASE} is not the recorded release ${release.release}`] });
    }
    const installed = await verifyInstalledRepoFacts(release, options.resolveFrom === undefined ? {} : { resolveFrom: options.resolveFrom });
    return new SharedFactsAnalyzer(installed.status === "verified" ? { status: "available", release } : { status: "unavailable", problems: installed.problems });
  }

  async analyze(reader: SourceReader): Promise<SharedFactsResult> {
    if (this.availability.status === "unavailable") {
      return { status: "incomplete", reason: "release_unavailable", problems: this.availability.problems };
    }
    const provenance = provenanceFor(this.availability.release, reader.budgets);
    const readerProblems = readerConformanceProblems(reader);
    if (readerProblems.length > 0) return { status: "incomplete", reason: "nonconforming_reader", problems: readerProblems, provenance };
    let document: unknown;
    try {
      document = await analyze(reader);
    } catch (error) {
      return { status: "incomplete", reason: "analysis_failed", problems: [messageOf(error)], provenance };
    }
    return acceptSharedDocument(document, { provenance, usage: reader.usage() });
  }
}

/**
 * Accepts a fact document only when it is a supported, valid, unmodified
 * repo-facts document. An expected digest, as from a cache, must match.
 */
export function acceptSharedDocument(
  input: unknown,
  context: { provenance: SharedFactsProvenance; usage: { files: number; bytes: number }; expectedDigest?: string },
): SharedFactsResult {
  const { provenance } = context;
  const envelope = typeof input === "object" && input !== null ? input as { schema?: unknown; schema_version?: unknown } : {};
  if (envelope.schema !== FACT_DOCUMENT_SCHEMA || typeof envelope.schema_version !== "number" || !SUPPORTED_FACT_DOCUMENT_VERSIONS.includes(envelope.schema_version)) {
    return {
      status: "incomplete",
      reason: "unsupported_schema",
      problems: [`Unsupported fact document ${String(envelope.schema)} version ${String(envelope.schema_version)}; supported: ${FACT_DOCUMENT_SCHEMA} version ${SUPPORTED_FACT_DOCUMENT_VERSIONS.join(", ")}`],
      provenance,
    };
  }
  const problems = factDocumentProblems(input);
  if (problems.length > 0) return { status: "incomplete", reason: "invalid_document", problems, provenance };
  const document = input as FactDocument;
  if (document.detector_release !== provenance.detectorRelease) {
    return { status: "incomplete", reason: "invalid_document", problems: [`The document names detector release ${document.detector_release}, not ${provenance.detectorRelease}`], provenance };
  }
  const documentDigest = digestOf(document).digest;
  if (context.expectedDigest !== undefined && context.expectedDigest !== documentDigest) {
    return { status: "incomplete", reason: "invalid_digest", problems: [`The document digest ${documentDigest} does not match ${context.expectedDigest}`], provenance };
  }
  const retained = freeze(document as unknown as JsonValue) as unknown as FactDocument;
  return {
    status: "complete",
    document: retained,
    documentDigest,
    provenance,
    diagnostics: retained.diagnostics,
    skippedInputs: retained.diagnostics
      .filter((diagnostic) => diagnostic.path !== "" && SKIPPED_INPUT_REASONS.has(diagnostic.reason))
      .map((diagnostic) => ({ path: diagnostic.path, reason: diagnostic.reason, detail: diagnostic.detail, detector: diagnostic.detector })),
    incompleteCategories: Object.entries(retained.categories)
      .filter(([, category]) => !category.search.complete || category.search.skipped.length > 0)
      .map(([id]) => id)
      .sort(compareCodeUnits),
    usage: context.usage,
  };
}

export function provenanceFor(release: RepoFactsRelease, limits: Budgets): SharedFactsProvenance {
  const { configuration, digest } = detectorConfiguration(limits);
  const syntax = configuration.syntax as { parser: string; parser_version: string; max_nodes: number; max_depth: number };
  return {
    detectorRelease: release.release,
    sourceCommit: release.commit,
    configurationDigest: digest,
    parser: { name: syntax.parser, version: syntax.parser_version, maxNodes: syntax.max_nodes, maxDepth: syntax.max_depth },
    limits: { ...limits },
    packages: release.packages.map((entry) => ({ name: entry.name, version: entry.version, integrity: entry.integrity })),
  };
}

/** Structural checks every conforming reader satisfies; the full suite runs in CI. */
function readerConformanceProblems(reader: SourceReader): string[] {
  const problems: string[] = [];
  const { maxBlobBytes, maxFiles, maxTotalBytes } = reader.budgets;
  if (![maxBlobBytes, maxFiles, maxTotalBytes].every((value) => Number.isSafeInteger(value) && value > 0)) problems.push("The reader's budgets are not positive integers");
  if (reader.commit !== null && !/^[0-9a-f]{40}$/.test(reader.commit)) problems.push("The reader's commit is neither null nor a commit id");
  for (let index = 0; index < reader.entries.length; index++) {
    const entry = reader.entries[index]!;
    const previous = reader.entries[index - 1];
    if (previous !== undefined && compareCodeUnits(previous.path, entry.path) >= 0) {
      problems.push(`The reader lists ${entry.path} out of code-unit order`);
      break;
    }
    if (entry.path.startsWith("/") || entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) {
      problems.push(`The reader lists a path the read policy rejects: ${entry.path}`);
      break;
    }
  }
  return problems;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
