import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverApplicationRoot } from "../../src/facts/application-root.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("application-root discovery", () => {
  it("uses the nearest package manifest inside the repository", async () => {
    const repository = await tree({ ".git/HEAD": "", "package.json": "{}", "src/components/Button.tsx": "" });
    const result = await discoverApplicationRoot({ cwd: path.join(repository, "src", "components") });
    expect(result).toMatchObject({ status: "resolved", root: repository, focus: "", repositoryRoot: repository, invocation: path.join(repository, "src", "components") });
    expect(result.markers).toEqual([{ kind: "package-manifest", path: "package.json" }, { kind: "repository", path: "" }]);
  });

  it("widens to an npm workspace root that includes the invoking package", async () => {
    for (const workspaces of [["packages/*"], { packages: ["packages/*"] }]) {
      const repository = await tree({ ".git/HEAD": "", "package.json": JSON.stringify({ workspaces }), "packages/shell-bus/package.json": "{}", "packages/shell-bus/src/index.ts": "" });
      const result = await discoverApplicationRoot({ cwd: path.join(repository, "packages", "shell-bus", "src") });
      expect(result).toMatchObject({ status: "resolved", root: repository, focus: "packages/shell-bus" });
      expect(result.markers).toContainEqual({ kind: "npm-workspaces", path: "package.json" });
    }
  });

  it("widens to a pnpm workspace root and honors negated patterns", async () => {
    const repository = await tree({
      ".git/HEAD": "",
      "package.json": "{}",
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/sandbox'\n",
      "packages/analytics/package.json": "{}",
      "packages/sandbox/package.json": "{}",
    });
    const member = await discoverApplicationRoot({ cwd: path.join(repository, "packages", "analytics") });
    expect(member).toMatchObject({ root: repository, focus: "packages/analytics" });
    expect(member.markers).toContainEqual({ kind: "pnpm-workspace", path: "pnpm-workspace.yaml" });
    const excluded = await discoverApplicationRoot({ cwd: path.join(repository, "packages", "sandbox") });
    expect(excluded).toMatchObject({ root: path.join(repository, "packages", "sandbox"), focus: "" });
  });

  it("never widens past the repository boundary", async () => {
    const outer = await tree({ "package.json": JSON.stringify({ workspaces: ["inner"] }), "inner/.git/HEAD": "", "inner/package.json": "{}" });
    const result = await discoverApplicationRoot({ cwd: path.join(outer, "inner") });
    expect(result).toMatchObject({ root: path.join(outer, "inner"), repositoryRoot: path.join(outer, "inner"), focus: "" });
  });

  it("reports an unresolved root when no manifest exists below the repository boundary", async () => {
    const repository = await tree({ ".git/HEAD": "", "docs/readme.md": "" });
    const result = await discoverApplicationRoot({ cwd: path.join(repository, "docs") });
    expect(result).toMatchObject({ status: "unresolved", root: repository, markers: [{ kind: "repository", path: "" }] });
  });

  it("accepts an explicit root and resolves symbolic links to real paths", async () => {
    const repository = await tree({ ".git/HEAD": "", "package.json": "{}", "packages/a/package.json": "{}" });
    const link = path.join(await temporary(), "linked");
    await fs.symlink(repository, link);
    const explicit = await discoverApplicationRoot({ cwd: path.join(link, "packages", "a"), root: link });
    expect(explicit).toMatchObject({ status: "resolved", root: repository, focus: "packages/a", invocation: path.join(repository, "packages", "a") });
    expect(explicit.markers).toEqual([{ kind: "explicit", path: "" }]);
  });
});

async function tree(files: Record<string, string>): Promise<string> {
  const root = await temporary();
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

async function temporary(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-root-")));
  temporaryDirectories.push(directory);
  return directory;
}
