import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import ssri from "ssri";
import { pack } from "tar-stream";

export interface InternalPackageFixture {
  name: string;
  version: string;
  files: Readonly<Record<string, string>>;
  scripts?: Readonly<Record<string, string>>;
  commit?: string;
}

interface PreparedPackage extends InternalPackageFixture {
  tarball: Buffer;
  integrity: string;
}

export interface InternalRegistryFixture {
  registry: string;
  cache: string;
  source: (name: string, version: string) => {
    schema: "web-doctor.npm-source";
    schemaVersion: 1;
    registry: "internal";
    packageName: string;
    version: string;
    integrity: string;
    provenance: { repository: string; commit: string };
  };
  close: () => Promise<void>;
}

export async function startInternalRegistry(
  fixtures: readonly InternalPackageFixture[],
): Promise<InternalRegistryFixture> {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-registry-cache-"));
  const packages = new Map<string, PreparedPackage>();
  for (const fixture of fixtures) {
    const tarball = await buildTarball(fixture);
    packages.set(`${fixture.name}@${fixture.version}`, {
      ...fixture,
      tarball,
      integrity: String(ssri.fromData(tarball, { algorithms: ["sha512"] })),
    });
  }

  const server = createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://registry.test").pathname);
    if (requestPath.startsWith("/tarballs/")) {
      const key = requestPath.slice("/tarballs/".length).replace(/\.tgz$/, "");
      const fixture = [...packages.values()].find((candidate) => tarballKey(candidate) === key);
      if (fixture === undefined) return notFound(response);
      response.setHeader("content-type", "application/octet-stream");
      response.end(fixture.tarball);
      return;
    }

    const packageName = requestPath.slice(1);
    const versions = [...packages.values()].filter((candidate) => candidate.name === packageName);
    if (versions.length === 0) return notFound(response);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Registry address is unavailable");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      name: packageName,
      "dist-tags": { latest: versions.at(-1)!.version },
      versions: Object.fromEntries(versions.map((fixture) => [fixture.version, {
        name: fixture.name,
        version: fixture.version,
        dist: {
          tarball: `http://127.0.0.1:${address.port}/tarballs/${tarballKey(fixture)}.tgz`,
          integrity: fixture.integrity,
        },
      }])),
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Registry address is unavailable");

  return {
    registry: `http://127.0.0.1:${address.port}/`,
    cache,
    source: (name, version) => {
      const fixture = packages.get(`${name}@${version}`);
      if (fixture === undefined) throw new Error(`Unknown fixture package ${name}@${version}`);
      return {
        schema: "web-doctor.npm-source",
        schemaVersion: 1,
        registry: "internal",
        packageName: name,
        version,
        integrity: fixture.integrity,
        provenance: {
          repository: `ssh://git.internal/${name.replace(/^@/, "").replace("/", "/")}.git`,
          commit: fixture.commit ?? "c".repeat(40),
        },
      };
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await fs.rm(cache, { recursive: true, force: true });
    },
  };
}

async function buildTarball(fixture: InternalPackageFixture): Promise<Buffer> {
  const archive = pack();
  const packageJson = JSON.stringify({ name: fixture.name, version: fixture.version, scripts: fixture.scripts ?? {} });
  archive.entry({ name: "package/package.json" }, packageJson);
  for (const [name, content] of Object.entries(fixture.files)) archive.entry({ name: `package/${name}` }, content);
  archive.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of archive) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("Tar stream emitted a non-byte chunk");
    chunks.push(Buffer.from(chunk));
  }
  return gzipSync(Buffer.concat(chunks));
}

function tarballKey(fixture: Pick<InternalPackageFixture, "name" | "version">): string {
  return `${fixture.name.replace(/^@/, "").replace("/", "-")}-${fixture.version}`;
}

function notFound(response: import("node:http").ServerResponse): void {
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not_found" }));
}