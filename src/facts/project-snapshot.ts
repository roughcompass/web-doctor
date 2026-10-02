import type { Budgets } from "@repo-facts/contract";
import { digestDocument } from "../contracts/index.js";
import { analyzeExtensions, type ExtensionFacts } from "./extensions.js";
import type { ProjectIndexLimits } from "./project-index.js";
import type { SharedFactsAnalyzer, SharedFactsResult } from "./shared-facts.js";
import { type WorkingTreeExclusion, WorkingTreeListing } from "./working-tree-reader.js";

/**
 * One analysis of one working tree: the unchanged shared fact document (or
 * why it is incomplete), the extension document and index, and the listing
 * they were computed from. Its digest identifies exactly those inputs.
 */
export interface ProjectSnapshot {
  root: string;
  treeDigest: string;
  exclusions: readonly WorkingTreeExclusion[];
  /** Regular files the read policy admits, in path order. */
  files: readonly string[];
  shared: SharedFactsResult;
  extensions: ExtensionFacts;
  digest: string;
}

export interface ProjectAnalysisOptions {
  root: string;
  repositoryRoot?: string | null;
  analyzer: SharedFactsAnalyzer;
  budgets?: Budgets;
  protectedDirectories?: readonly string[];
  indexLimits?: Partial<ProjectIndexLimits>;
}

export async function analyzeProject(options: ProjectAnalysisOptions): Promise<ProjectSnapshot> {
  const listing = await WorkingTreeListing.scan({
    root: options.root,
    ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
    ...(options.protectedDirectories === undefined ? {} : { protectedDirectories: options.protectedDirectories }),
  });
  return snapshotOf(listing, options);
}

/** Analyzes a listing with fresh readers: one for the shared release, one for Web Doctor's extensions. */
export async function snapshotOf(listing: WorkingTreeListing, options: Omit<ProjectAnalysisOptions, "root" | "repositoryRoot" | "protectedDirectories">): Promise<ProjectSnapshot> {
  const shared = await options.analyzer.analyze(listing.open(options.budgets));
  const extensions = await analyzeExtensions(listing.open(options.budgets), {
    ...(shared.status === "complete" ? { shared: shared.document } : {}),
    ...(options.indexLimits === undefined ? {} : { index: { limits: options.indexLimits } }),
  });
  return {
    root: listing.root,
    treeDigest: listing.digest,
    exclusions: listing.exclusions,
    files: listing.open(options.budgets).files().map((entry) => entry.path),
    shared,
    extensions,
    digest: snapshotDigest(listing.digest, shared, extensions),
  };
}

export function snapshotDigest(treeDigest: string, shared: SharedFactsResult, extensions: ExtensionFacts): string {
  return digestDocument({
    tree: treeDigest,
    shared: shared.status === "complete" ? shared.documentDigest : { incomplete: shared.reason },
    extensions: extensions.digest,
  }).digest;
}
