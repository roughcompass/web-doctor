import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ssri from "ssri";
import {
  canonicalJson,
  digestDocument,
  parseContract,
  type Contribution,
  type ContributionFixture,
  type ContractKind,
} from "../contracts/index.js";

const execFileAsync = promisify(execFile);
const DOCUMENT_KINDS = {
  policy: "policyPack",
  provider: "providerManifest",
  guidance: "guidanceEntry",
} as const satisfies Record<Contribution["documents"][number]["kind"], ContractKind>;

export interface ContributionPackOptions {
  root: string;
  manifestPath?: string;
  outputDirectory: string;
}

export interface ContributionPackResult {
  packageName: string;
  version: string;
  filename: string;
  integrity: string;
  manifestDigest: string;
  provenance: Contribution["provenance"];
  files: string[];
}

export async function packContribution(options: ContributionPackOptions): Promise<ContributionPackResult> {
  const root = await fs.realpath(options.root);
  const manifestPath = options.manifestPath ?? "web-doctor.json";
  const packageJson = JSON.parse((await readSourceFile(root, "package.json")).toString("utf8")) as Record<string, unknown>;
  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    throw new Error("package.json requires string name and version fields");
  }
  const manifest = parseContract(
    "contribution",
    JSON.parse((await readSourceFile(root, manifestPath)).toString("utf8")) as unknown,
  ) as Contribution;
  const declaredPaths = new Set<string>([
    manifestPath,
    ...manifest.documents.map((document) => document.path),
    ...manifest.fixtures,
    ...manifest.runtimeArtifacts.map((artifact) => artifact.path),
  ]);

  for (const document of manifest.documents) {
    parseContract(DOCUMENT_KINDS[document.kind], JSON.parse((await readSourceFile(root, document.path)).toString("utf8")) as unknown);
  }
  for (const fixturePath of manifest.fixtures) {
    const fixture = parseContract(
      "contributionFixture",
      JSON.parse((await readSourceFile(root, fixturePath)).toString("utf8")) as unknown,
    ) as ContributionFixture;
    declaredPaths.add(fixture.input);
    let accepted = true;
    try {
      parseContract(fixture.contract, JSON.parse((await readSourceFile(root, fixture.input)).toString("utf8")) as unknown);
    } catch {
      accepted = false;
    }
    if ((fixture.expected === "accept") !== accepted) throw new Error(`Fixture ${fixture.id} expected ${fixture.expected}`);
  }
  for (const artifact of manifest.runtimeArtifacts) {
    const digest = crypto.createHash("sha256").update(await readSourceFile(root, artifact.path)).digest("hex");
    if (digest !== artifact.digest) throw new Error(`Runtime artifact digest mismatch for ${artifact.path}`);
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-contribution-pack-"));
  const stagingRoot = path.join(workspace, "package");
  try {
    await fs.mkdir(stagingRoot, { recursive: true });
    const files = [...declaredPaths].sort();
    await fs.writeFile(path.join(stagingRoot, "package.json"), `${canonicalJson({ ...packageJson, files })}\n`, "utf8");
    for (const packagePath of files) {
      const source = await readSourceFile(root, packagePath);
      const destination = path.join(stagingRoot, ...packagePath.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const contents = packagePath.endsWith(".json")
        ? Buffer.from(`${canonicalJson(JSON.parse(source.toString("utf8")) as unknown)}\n`, "utf8")
        : source;
      await fs.writeFile(destination, contents);
    }
    await fs.mkdir(options.outputDirectory, { recursive: true });
    const { stdout } = await execFileAsync("npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", path.resolve(options.outputDirectory),
    ], { cwd: stagingRoot, encoding: "utf8" });
    const packed = (JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>)[0];
    if (packed === undefined) throw new Error("npm pack did not report an output tarball");
    const tarball = await fs.readFile(path.join(options.outputDirectory, packed.filename));
    return {
      packageName: packageJson.name,
      version: packageJson.version,
      filename: packed.filename,
      integrity: String(ssri.fromData(tarball, { algorithms: ["sha512"] })),
      manifestDigest: digestDocument(manifest).digest,
      provenance: manifest.provenance,
      files: packed.files.map((file) => file.path).sort(),
    };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function readSourceFile(root: string, packagePath: string): Promise<Buffer> {
  const candidate = path.resolve(root, ...packagePath.split("/"));
  const realCandidate = await fs.realpath(candidate);
  const relative = path.relative(root, realCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Package path ${packagePath} escapes contribution root`);
  }
  const stat = await fs.stat(realCandidate);
  if (!stat.isFile()) throw new Error(`Package path ${packagePath} is not a regular file`);
  return fs.readFile(realCandidate);
}