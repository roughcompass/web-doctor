import fs from "node:fs/promises";
import path from "node:path";
import { type Budgets, type FactDocument, type MemoryFile, MemoryReader, dump, parseCanonical } from "@repo-facts/contract";

/**
 * The repo-facts golden fixtures vendored from the pinned release's source
 * commit (see test/fixtures/repo-facts/SOURCE.json). Each has a tree, the
 * fact document the release must produce, and optional commit, budgets, and
 * gitlinks.
 */

export const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/repo-facts");

export interface GoldenFixture {
  name: string;
  files: Record<string, MemoryFile>;
  commit: string | null;
  budgets?: Budgets;
  expected: string;
}

export async function goldenFixtureNames(): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await fs.readdir(FIXTURES, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names.sort();
}

export async function loadGoldenFixture(name: string): Promise<GoldenFixture> {
  const directory = path.join(FIXTURES, name);
  const options = JSON.parse(await fs.readFile(path.join(directory, "fixture.json"), "utf8")) as { commit?: string | null; budgets?: Budgets; gitlinks?: Record<string, string> };
  const files = await readTree(path.join(directory, "tree"));
  for (const [key, commit] of Object.entries(options.gitlinks ?? {})) files[key] = { gitlink: commit };
  return {
    name,
    files,
    commit: options.commit ?? null,
    ...(options.budgets && { budgets: options.budgets }),
    expected: await fs.readFile(path.join(directory, "expected.json"), "utf8"),
  };
}

export async function readTree(tree: string): Promise<Record<string, MemoryFile>> {
  const files: Record<string, MemoryFile> = {};
  for (const relative of (await fs.readdir(tree, { recursive: true, encoding: "utf8" })).sort()) {
    const file = path.join(tree, relative);
    const stat = await fs.lstat(file);
    const key = relative.split(path.sep).join("/");
    if (stat.isSymbolicLink()) files[key] = { symlink: await fs.readlink(file) };
    else if (stat.isFile()) files[key] = stat.mode & 0o100 ? { content: await fs.readFile(file), executable: true } : await fs.readFile(file);
  }
  return files;
}

export function memoryReaderFor(files: Readonly<Record<string, MemoryFile>>, options: { budgets?: Budgets; protectedDirectories?: readonly string[] } = {}): MemoryReader {
  return MemoryReader.fromFiles(files, options);
}

/**
 * Stores files as a working tree under +root+, which becomes a Git working
 * tree so submodule checkouts can name their commit through `.git/modules`.
 */
export async function materialize(root: string, files: Readonly<Record<string, MemoryFile>>): Promise<void> {
  await fs.mkdir(path.join(root, ".git", "modules"), { recursive: true });
  for (const [key, file] of Object.entries(files)) {
    const absolute = path.join(root, ...key.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    if (typeof file === "string" || file instanceof Uint8Array) {
      await fs.writeFile(absolute, file, { mode: 0o644 });
    } else if ("symlink" in file) {
      await fs.symlink(file.symlink, absolute);
    } else if ("gitlink" in file) {
      const metadata = path.join(root, ".git", "modules", ...key.split("/"));
      await fs.mkdir(metadata, { recursive: true });
      await fs.writeFile(path.join(metadata, "HEAD"), `${file.gitlink}\n`);
      await fs.mkdir(absolute, { recursive: true });
      await fs.writeFile(path.join(absolute, ".git"), `gitdir: ${path.relative(absolute, metadata)}\n`);
    } else {
      await fs.writeFile(absolute, file.content);
      await fs.chmod(absolute, 0o755);
    }
  }
}

/** The stored form repo-facts uses: canonical key order, indented, with the release replaced. */
export function storedDocument(document: FactDocument): string {
  return `${JSON.stringify(parseCanonical(dump({ ...document, detector_release: "golden" })), null, 2)}\n`;
}
