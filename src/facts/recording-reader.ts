import type { Budgets, ReadResult, SkipDiagnostic, SourceReader, TreeEntry } from "@repo-facts/contract";

/** A SourceReader that records every path read through it, so a result can be keyed by what it depended on. */
export class RecordingReader implements SourceReader {
  readonly reads = new Set<string>();

  constructor(private readonly inner: SourceReader) {}

  get commit(): string | null {
    return this.inner.commit;
  }

  get entries(): readonly TreeEntry[] {
    return this.inner.entries;
  }

  get budgets(): Budgets {
    return this.inner.budgets;
  }

  files(): TreeEntry[] {
    return this.inner.files();
  }

  entry(path: string): TreeEntry | undefined {
    return this.inner.entry(path);
  }

  read(path: string): Promise<ReadResult> {
    this.reads.add(path);
    return this.inner.read(path);
  }

  readMany(paths: readonly string[]): Promise<Map<string, ReadResult>> {
    for (const path of paths) this.reads.add(path);
    return this.inner.readMany(paths);
  }

  linkTarget(path: string): Promise<string | null> {
    this.reads.add(path);
    return this.inner.linkTarget(path);
  }

  diagnostics(): SkipDiagnostic[] {
    return this.inner.diagnostics();
  }

  usage(): { files: number; bytes: number } {
    return this.inner.usage();
  }
}
