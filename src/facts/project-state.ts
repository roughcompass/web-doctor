import fs from "node:fs";
import type { Budgets, DocumentFact, FactDocument } from "@repo-facts/contract";
import { canonicalJson, digestDocument } from "../contracts/index.js";
import { analyzeExtensions, WEB_DOCTOR_EXTENSION_RELEASE, type ExtensionFacts } from "./extensions.js";
import { IndexSession, type ProjectIndexLimits } from "./project-index.js";
import { snapshotDigest, type ProjectSnapshot } from "./project-snapshot.js";
import { RecordingReader } from "./recording-reader.js";
import { SHARED_EXTENSION_INPUTS } from "./source-detectors.js";
import type { SharedFactsAnalyzer, SharedFactsResult } from "./shared-facts.js";
import { WorkingTreeListing } from "./working-tree-reader.js";

/**
 * Live project context for a long-running process.
 *
 * A recursive watcher records every change it observes. `current()` never
 * returns a snapshot older than the last observed change: it rescans the
 * working tree when changes are pending and repeats if more arrive while it
 * computes. The shared detector result is reused only for identical listed
 * content. Extension facts are reused only when every file they read, the
 * set of paths that exist, and the shared document are unchanged.
 */

export interface ProjectStateOptions {
  root: string;
  repositoryRoot?: string | null;
  analyzer: SharedFactsAnalyzer;
  budgets?: Budgets;
  protectedDirectories?: readonly string[];
  indexLimits?: Partial<ProjectIndexLimits>;
  /** Watch for changes (default). Without a watcher every call rescans. */
  watch?: boolean;
}

export interface RefreshReport {
  changedPaths: string[];
  sharedReused: boolean;
  extensionsReused: boolean;
  /** Extension fact keys whose value or evidence changed, or that appeared or disappeared. */
  invalidatedFacts: string[];
}

export interface ProjectStateStats {
  scans: number;
  sharedRuns: number;
  extensionRuns: number;
}

interface ExtensionEntry {
  key: string;
  reads: readonly string[];
  facts: ExtensionFacts;
}

const IGNORED_EVENT_PREFIXES = [".git/", "node_modules/"];

export class ProjectState {
  readonly stats: ProjectStateStats = { scans: 0, sharedRuns: 0, extensionRuns: 0 };
  lastRefresh: RefreshReport | null = null;
  private snapshot: ProjectSnapshot | undefined;
  private observed = 0;
  private applied = -1;
  private readonly pending = new Set<string>();
  private watcher: fs.FSWatcher | undefined;
  private watching = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Set<() => void>();
  private shared: { listingDigest: string; result: SharedFactsResult } | undefined;
  private extensions: ExtensionEntry | undefined;
  private readonly session = new IndexSession();

  private constructor(private readonly options: ProjectStateOptions) {}

  static async open(options: ProjectStateOptions): Promise<ProjectState> {
    const state = new ProjectState(options);
    if (options.watch !== false) state.startWatching();
    await state.current();
    return state;
  }

  /** Changes observed so far; tests and callers can wait for one before querying. */
  get observedChanges(): number {
    return this.observed;
  }

  get isWatching(): boolean {
    return this.watching;
  }

  /** Resolves once a change after +after+ has been observed, or rejects after +timeoutMs+. */
  waitForChange(after: number, timeoutMs = 5_000): Promise<void> {
    if (this.observed > after) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`No change was observed within ${timeoutMs} ms`));
      }, timeoutMs);
      const check = () => {
        if (this.observed <= after) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }

  /** The snapshot for the working tree as of the last observed change. */
  current(): Promise<ProjectSnapshot> {
    const next = this.queue.then(() => this.refresh());
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    this.watching = false;
    await this.queue;
    this.session.dispose();
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.options.root, { recursive: true }, (_event, filename) => {
        const path = filename === null ? "" : String(filename).split("\\").join("/");
        if (IGNORED_EVENT_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix) || path.includes(`/${prefix}`))) return;
        this.pending.add(path);
        this.observed++;
        for (const waiter of [...this.waiters]) waiter();
      });
      this.watcher.on("error", () => {
        // A failed watcher can no longer vouch for freshness; every call rescans.
        this.watching = false;
      });
      this.watching = true;
    } catch {
      this.watching = false;
    }
  }

  private async refresh(): Promise<ProjectSnapshot> {
    for (;;) {
      if (this.snapshot !== undefined && this.watching && this.applied === this.observed) return this.snapshot;
      const generation = this.observed;
      const changedPaths = [...this.pending].sort();
      this.pending.clear();
      const listing = await WorkingTreeListing.scan({
        root: this.options.root,
        ...(this.options.repositoryRoot === undefined ? {} : { repositoryRoot: this.options.repositoryRoot }),
        ...(this.options.protectedDirectories === undefined ? {} : { protectedDirectories: this.options.protectedDirectories }),
      });
      this.stats.scans++;
      const sharedReused = this.shared?.listingDigest === listing.digest;
      if (!sharedReused) {
        this.shared = { listingDigest: listing.digest, result: await this.options.analyzer.analyze(listing.open(this.options.budgets)) };
        this.stats.sharedRuns++;
      }
      const shared = this.shared!.result;
      const previous = this.extensions;
      const extensionsReused = previous !== undefined && previous.key === extensionKey(listing, shared, previous.reads, this.options);
      if (!extensionsReused) {
        const reader = new RecordingReader(listing.open(this.options.budgets));
        const facts = await analyzeExtensions(reader, {
          ...(shared.status === "complete" ? { shared: shared.document } : {}),
          index: { ...(this.options.indexLimits === undefined ? {} : { limits: this.options.indexLimits }), session: this.session },
        });
        const reads = [...reader.reads].sort();
        this.extensions = { key: extensionKey(listing, shared, reads, this.options), reads, facts };
        this.stats.extensionRuns++;
      }
      const extensions = this.extensions!.facts;
      this.snapshot = {
        root: listing.root,
        treeDigest: listing.digest,
        exclusions: listing.exclusions,
        files: listing.open(this.options.budgets).files().map((entry) => entry.path),
        shared,
        extensions,
        digest: snapshotDigest(listing.digest, shared, extensions),
      };
      this.lastRefresh = {
        changedPaths,
        sharedReused,
        extensionsReused,
        invalidatedFacts: previous === undefined || extensionsReused ? [] : changedFacts(previous.facts, extensions),
      };
      this.applied = generation;
      if (!this.watching || this.observed === generation) return this.snapshot;
    }
  }
}

/** Everything extension facts can depend on: the files they read, which paths exist, and the shared document. */
function extensionKey(listing: WorkingTreeListing, shared: SharedFactsResult, reads: readonly string[], options: ProjectStateOptions): string {
  const objectIds = new Map(listing.entries.map((entry) => [entry.path, entry.objectId]));
  return digestDocument({
    release: WEB_DOCTOR_EXTENSION_RELEASE,
    budgets: options.budgets === undefined ? null : { ...options.budgets },
    limits: options.indexLimits === undefined ? null : { ...options.indexLimits },
    shared: shared.status === "complete" ? sharedInputs(shared.document) : shared.reason,
    paths: listing.entries.map((entry) => [entry.path, entry.type]),
    reads: reads.map((path) => [path, objectIds.get(path) ?? null]),
  }).digest;
}

/** The shared facts extensions consume: their categories' facts, with evidence reduced to the paths they cite. */
function sharedInputs(document: FactDocument): unknown {
  return SHARED_EXTENSION_INPUTS.map((id) => (document.categories[id]?.facts ?? []).map((fact) => ({
    key: fact.key,
    state: fact.state,
    value: fact.value,
    candidates: fact.candidates?.map((candidate) => candidate.value) ?? null,
    paths: fact.evidence.map((evidence) => document.evidence[evidence]?.path ?? null),
  })));
}

function changedFacts(before: ExtensionFacts, after: ExtensionFacts): string[] {
  const identities = (facts: ExtensionFacts) => {
    const map = new Map<string, string>();
    for (const [category, entry] of Object.entries(facts.categories)) {
      for (const fact of entry.facts) map.set(`${category}/${fact.key}`, identity(fact, facts));
    }
    return map;
  };
  const left = identities(before);
  const right = identities(after);
  return [...new Set([...left.keys(), ...right.keys()])].filter((key) => left.get(key) !== right.get(key)).sort();
}

function identity(fact: DocumentFact, facts: ExtensionFacts): string {
  return canonicalJson({ state: fact.state, value: fact.value, evidence: fact.evidence.map((id) => facts.document.evidence[id]?.object_id ?? id) });
}
