import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pacote from "pacote";
import {
  internalNpmSourceSchema,
  packagePathSchema,
  type InternalNpmSource,
} from "../contracts/index.js";

export interface NpmArtifactResolverOptions {
  registry: string;
  cache?: string;
  allowInsecureRegistry?: boolean;
}

export interface ResolvedNpmArtifact {
  source: InternalNpmSource;
  files: ReadonlyMap<string, Buffer>;
}

export async function readInternalNpmArtifact(
  sourceInput: unknown,
  requestedPaths: readonly string[],
  options: NpmArtifactResolverOptions,
): Promise<ResolvedNpmArtifact> {
  const source = internalNpmSourceSchema.parse(sourceInput);
  const registry = validatedRegistry(options);
  const paths = [...new Set(requestedPaths.map((requestedPath) => packagePathSchema.parse(requestedPath)))];
  const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-npm-"));

  try {
    await pacote.extract(`${source.packageName}@${source.version}`, extractionRoot, {
      registry,
      integrity: source.integrity,
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    });

    const realRoot = await fs.realpath(extractionRoot);
    const files = new Map<string, Buffer>();
    for (const requestedPath of paths) {
      const target = path.resolve(realRoot, ...requestedPath.split("/"));
      assertInside(realRoot, target, requestedPath);
      const realTarget = await fs.realpath(target);
      assertInside(realRoot, realTarget, requestedPath);
      const stat = await fs.stat(realTarget);
      if (!stat.isFile()) throw new Error(`Package path ${requestedPath} is not a regular file`);
      files.set(requestedPath, await fs.readFile(realTarget));
    }

    return { source, files };
  } finally {
    await fs.rm(extractionRoot, { recursive: true, force: true });
  }
}

function validatedRegistry(options: NpmArtifactResolverOptions): string {
  const registry = new URL(options.registry);
  if (registry.protocol !== "https:" && !(options.allowInsecureRegistry === true && registry.protocol === "http:")) {
    throw new Error("Internal npm registry must use HTTPS");
  }
  return registry.href;
}

function assertInside(root: string, candidate: string, requestedPath: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error(`Package path ${requestedPath} escapes the extracted package`);
}