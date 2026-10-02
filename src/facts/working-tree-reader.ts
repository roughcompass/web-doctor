import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type Budgets,
  DEFAULT_BUDGETS,
  PolicyReader,
  ReadPolicy,
  type SkipDiagnostic,
  type TreeEntry,
  compareCodeUnits,
  gitBlobId,
} from "@repo-facts/contract";
import ignore, { type Ignore } from "ignore";
import { canonicalJson } from "../contracts/index.js";

/**
 * A working tree exposed through the shared SourceReader contract.
 *
 * The listing is the tree Git would see: committed `.gitignore` rules,
 * dependency directories, and `.git` itself are left out before the shared
 * read policy runs. Every file, link, submodule, and directory carries the
 * Git object id computed from its bytes, so identical content has the same
 * identity as in a snapshot reader. Reads re-verify that identity and never
 * follow a symbolic link, so a file changed or swapped for a link after
 * listing is reported missing rather than read.
 */

export const DEPENDENCY_DIRECTORIES: readonly string[] = ["node_modules", "bower_components", "jspm_packages"];
export const NULL_OBJECT_ID = "0".repeat(40);

export type WorkingTreeExclusionReason = "dependency_directory" | "gitignored" | "special_file";

export interface WorkingTreeExclusion {
  path: string;
  reason: WorkingTreeExclusionReason;
  detail: string;
}

export interface WorkingTreeScanOptions {
  /** Absolute real path of the application root. */
  root: string;
  /** The enclosing Git working tree, whose `.gitignore` files above the root also apply. */
  repositoryRoot?: string | null;
  /** Directory names never read at any depth, compared case-insensitively. */
  protectedDirectories?: readonly string[];
}

interface Matcher {
  /** Root-relative directory of the `.gitignore`, or null for one above the root. */
  base: string | null;
  /** For a `.gitignore` above the root, the root's path relative to it. */
  prefix: string;
  rules: Ignore;
}

export class WorkingTreeListing {
  private constructor(
    readonly root: string,
    /** Every listed entry before the read policy, in code-unit path order. */
    readonly entries: readonly TreeEntry[],
    readonly exclusions: readonly WorkingTreeExclusion[],
    readonly protectedDirectories: readonly string[],
  ) {}

  static async scan(options: WorkingTreeScanOptions): Promise<WorkingTreeListing> {
    const root = await fs.realpath(options.root);
    const repositoryRoot = options.repositoryRoot === undefined || options.repositoryRoot === null ? null : await fs.realpath(options.repositoryRoot);
    const entries = new Map<string, TreeEntry>();
    const exclusions: WorkingTreeExclusion[] = [];
    const matchers = await ancestorMatchers(root, repositoryRoot);

    const visit = async (directory: string, relativeDirectory: string, inherited: readonly Matcher[]): Promise<boolean> => {
      const dirents = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => compareCodeUnits(left.name, right.name));
      const active = [...inherited];
      if (dirents.some((dirent) => dirent.name === ".gitignore" && dirent.isFile())) {
        active.push({ base: relativeDirectory, prefix: "", rules: ignore().add(await fs.readFile(path.join(directory, ".gitignore"), "utf8")) });
      }
      let listed = false;
      for (const dirent of dirents) {
        if (dirent.name === ".git") continue;
        const relative = relativeDirectory === "" ? dirent.name : `${relativeDirectory}/${dirent.name}`;
        const absolute = path.join(directory, dirent.name);
        if (DEPENDENCY_DIRECTORIES.includes(dirent.name)) {
          exclusions.push({ path: relative, reason: "dependency_directory", detail: "Dependency directories are not part of the application source" });
          continue;
        }
        if (isIgnored(active, relative, dirent.isDirectory())) {
          exclusions.push({ path: relative, reason: "gitignored", detail: "A committed .gitignore excludes this path" });
          continue;
        }
        if (dirent.isDirectory()) {
          if (await exists(path.join(absolute, ".git"))) {
            entries.set(relative, { path: relative, mode: "160000", type: "gitlink", objectId: await submoduleHead(absolute, root, repositoryRoot), size: null });
            listed = true;
          } else if (await visit(absolute, relative, active)) {
            entries.set(relative, { path: relative, mode: "040000", type: "tree", objectId: "", size: null });
            listed = true;
          }
        } else if (dirent.isSymbolicLink()) {
          const target = await fs.readlink(absolute, { encoding: "buffer" });
          entries.set(relative, { path: relative, mode: "120000", type: "symlink", objectId: gitBlobId(target), size: target.length });
          listed = true;
        } else if (dirent.isFile()) {
          const blob = await hashFile(absolute);
          entries.set(relative, { path: relative, mode: blob.executable ? "100755" : "100644", type: blob.executable ? "executable" : "file", objectId: blob.objectId, size: blob.size });
          listed = true;
        } else {
          exclusions.push({ path: relative, reason: "special_file", detail: "Sockets, pipes, and devices are not repository content" });
        }
      }
      return listed;
    };

    await visit(root, "", matchers);
    assignTreeIds(entries);
    return new WorkingTreeListing(
      root,
      [...entries.values()].sort((left, right) => compareCodeUnits(left.path, right.path)),
      exclusions.sort((left, right) => compareCodeUnits(left.path, right.path)),
      [...(options.protectedDirectories ?? [])],
    );
  }

  /** SHA-256 identity of the listed content: every path, mode, and object id. */
  get digest(): string {
    return crypto.createHash("sha256").update(canonicalJson(this.entries.map((entry) => [entry.path, entry.mode, entry.objectId]))).digest("hex");
  }

  /** Opens a fresh reader, with its own budgets and diagnostics, over this listing. */
  open(budgets: Budgets = DEFAULT_BUDGETS): WorkingTreeReader {
    const policy = new ReadPolicy({ protectedDirectories: this.protectedDirectories });
    const { entries, rejected } = policy.filterEntries(this.entries);
    return new WorkingTreeReader(this.root, entries, rejected, budgets, policy);
  }
}

export class WorkingTreeReader extends PolicyReader {
  constructor(
    private readonly root: string,
    entries: readonly TreeEntry[],
    rejected: readonly SkipDiagnostic[],
    budgets: Budgets,
    policy: ReadPolicy,
  ) {
    super(null, entries, rejected, budgets, policy);
  }

  static async open(options: WorkingTreeScanOptions & { budgets?: Budgets }): Promise<WorkingTreeReader> {
    return (await WorkingTreeListing.scan(options)).open(options.budgets);
  }

  protected async fetchBlobs(entries: readonly TreeEntry[]): Promise<Map<string, Buffer>> {
    const objects = new Map<string, Buffer>();
    for (const entry of entries) {
      const bytes = await this.readVerified(entry, async (file) => {
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          return (await handle.stat()).isFile() ? await handle.readFile() : null;
        } finally {
          await handle.close();
        }
      });
      if (bytes !== null) objects.set(entry.objectId, bytes);
    }
    return objects;
  }

  protected async fetchLink(entry: TreeEntry): Promise<Buffer | null> {
    return this.readVerified(entry, async (file) => ((await fs.lstat(file)).isSymbolicLink() ? fs.readlink(file, { encoding: "buffer" }) : null));
  }

  /** Reads only when no path component is a link and the bytes still have the listed object id. */
  private async readVerified(entry: TreeEntry, read: (file: string) => Promise<Buffer | null>): Promise<Buffer | null> {
    const segments = entry.path.split("/");
    const parent = path.join(this.root, ...segments.slice(0, -1));
    try {
      if ((await fs.realpath(parent)) !== parent) return null;
      const bytes = await read(path.join(parent, segments.at(-1)!));
      return bytes !== null && gitBlobId(bytes) === entry.objectId ? bytes : null;
    } catch {
      return null;
    }
  }
}

async function hashFile(file: string): Promise<{ objectId: string; size: number; executable: boolean }> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const hash = crypto.createHash("sha1").update(`blob ${stat.size}\0`);
    const buffer = Buffer.allocUnsafe(65_536);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    const executable = (stat.mode & 0o100) !== 0;
    if (total === stat.size) return { objectId: hash.digest("hex"), size: total, executable };
    // The file changed size while it was hashed; identify the bytes actually read.
    const bytes = await handle.readFile();
    return { objectId: gitBlobId(bytes), size: bytes.length, executable };
  } finally {
    await handle.close();
  }
}

async function ancestorMatchers(root: string, repositoryRoot: string | null): Promise<Matcher[]> {
  if (repositoryRoot === null || repositoryRoot === root || !within(repositoryRoot, root)) return [];
  const matchers: Matcher[] = [];
  const segments = path.relative(repositoryRoot, root).split(path.sep);
  for (let depth = 0; depth < segments.length; depth++) {
    const directory = path.join(repositoryRoot, ...segments.slice(0, depth));
    try {
      const file = path.join(directory, ".gitignore");
      if ((await fs.lstat(file)).isFile()) matchers.push({ base: null, prefix: segments.slice(depth).join("/"), rules: ignore().add(await fs.readFile(file, "utf8")) });
    } catch {
      // No .gitignore at this level.
    }
  }
  return matchers;
}

/** Git precedence: deeper `.gitignore` files override shallower ones; the last matching rule wins. */
function isIgnored(matchers: readonly Matcher[], relative: string, directory: boolean): boolean {
  let ignored = false;
  for (const matcher of matchers) {
    let candidate: string;
    if (matcher.base === null) candidate = `${matcher.prefix}/${relative}`;
    else if (matcher.base === "") candidate = relative;
    else if (relative.startsWith(`${matcher.base}/`)) candidate = relative.slice(matcher.base.length + 1);
    else continue;
    try {
      const result = matcher.rules.test(directory ? `${candidate}/` : candidate);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    } catch {
      // A name the matcher cannot express as a relative path is not ignored.
    }
  }
  return ignored;
}

/** The commit a submodule checkout's HEAD names, read from its Git metadata inside the tree or repository. */
async function submoduleHead(directory: string, root: string, repositoryRoot: string | null): Promise<string> {
  try {
    const dotGit = path.join(directory, ".git");
    const stat = await fs.lstat(dotGit);
    let gitDirectory: string;
    if (stat.isDirectory()) gitDirectory = dotGit;
    else if (stat.isFile()) {
      const match = /^gitdir: (.+)$/.exec((await fs.readFile(dotGit, "utf8")).trim());
      if (match === null) return NULL_OBJECT_ID;
      gitDirectory = await fs.realpath(path.resolve(directory, match[1]!));
    } else return NULL_OBJECT_ID;
    if (!within(root, gitDirectory) && !(repositoryRoot !== null && within(repositoryRoot, gitDirectory))) return NULL_OBJECT_ID;

    const head = (await fs.readFile(path.join(gitDirectory, "HEAD"), "utf8")).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const reference = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
    if (reference === undefined || reference.split("/").some((segment) => segment === ".." || segment === "")) return NULL_OBJECT_ID;
    try {
      const loose = (await fs.readFile(path.join(gitDirectory, ...reference.split("/")), "utf8")).trim();
      if (/^[0-9a-f]{40}$/.test(loose)) return loose;
    } catch {
      // Fall through to packed references.
    }
    for (const line of (await fs.readFile(path.join(gitDirectory, "packed-refs"), "utf8")).split("\n")) {
      const [objectId, name] = line.trim().split(" ");
      if (name === reference && objectId !== undefined && /^[0-9a-f]{40}$/.test(objectId)) return objectId;
    }
  } catch {
    // Unreadable submodule metadata leaves the commit unknown.
  }
  return NULL_OBJECT_ID;
}

/** Git tree ids, bottom-up: SHA-1 of `tree <size>\0` and the name-ordered entries. */
function assignTreeIds(entries: Map<string, TreeEntry>): void {
  const children = new Map<string, TreeEntry[]>();
  for (const entry of entries.values()) {
    const slash = entry.path.lastIndexOf("/");
    const parent = slash === -1 ? "" : entry.path.slice(0, slash);
    children.set(parent, [...(children.get(parent) ?? []), entry]);
  }
  const trees = [...entries.values()].filter((entry) => entry.type === "tree").sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const tree of trees) {
    const name = (entry: TreeEntry) => entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const key = (entry: TreeEntry) => (entry.type === "tree" ? `${name(entry)}/` : name(entry));
    const body = Buffer.concat(
      [...(children.get(tree.path) ?? [])]
        .sort((left, right) => compareCodeUnits(key(left), key(right)))
        .map((entry) => Buffer.concat([Buffer.from(`${entry.type === "tree" ? "40000" : entry.mode} ${name(entry)}\0`), Buffer.from(entry.objectId, "hex")])),
    );
    tree.objectId = crypto.createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
