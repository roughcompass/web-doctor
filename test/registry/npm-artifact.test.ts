import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import ssri from "ssri";
import { pack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInternalNpmArtifact } from "../../src/registry/npm-artifact.js";

const COMMIT = "c".repeat(40);
const PACKAGE_NAME = "@firm/artifact-fixture";
const PACKAGE_VERSION = "1.0.0";

describe("internal npm artifact resolver", () => {
  let server: Server;
  let registry: string;
  let cache: string;
  let tarball: Buffer;
  let integrity: string;

  beforeEach(async () => {
    cache = await fs.mkdtemp(path.join(os.tmpdir(), "web-doctor-cache-"));
    tarball = await buildTarball({
      "package.json": JSON.stringify({
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        scripts: { preinstall: "node -e \"require('fs').writeFileSync('preinstall-ran', 'yes')\"" },
      }),
      "web-doctor.json": JSON.stringify({ schema: "web-doctor.contribution", schemaVersion: 1 }),
      "policy.json": JSON.stringify({ schema: "web-doctor.policy-pack", schemaVersion: 1 }),
    });
    integrity = String(ssri.fromData(tarball, { algorithms: ["sha512"] }));

    server = createServer((request, response) => {
      const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://registry.test").pathname);
      if (requestPath === `/${PACKAGE_NAME}`) {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Registry address is unavailable");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: PACKAGE_NAME,
            "dist-tags": { latest: PACKAGE_VERSION },
            versions: {
              [PACKAGE_VERSION]: {
                name: PACKAGE_NAME,
                version: PACKAGE_VERSION,
                dist: {
                  tarball: `http://127.0.0.1:${address.port}/tarballs/artifact-fixture.tgz`,
                  integrity,
                },
              },
            },
          }),
        );
        return;
      }
      if (requestPath === "/tarballs/artifact-fixture.tgz") {
        response.setHeader("content-type", "application/octet-stream");
        response.end(tarball);
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Registry address is unavailable");
    registry = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(cache, { recursive: true, force: true });
  });

  it("retrieves exact package files after integrity verification without running lifecycle scripts", async () => {
    const result = await readInternalNpmArtifact(source(), ["web-doctor.json", "policy.json"], {
      registry,
      cache,
      allowInsecureRegistry: true,
    });

    expect(JSON.parse(result.files.get("web-doctor.json")!.toString("utf8"))).toMatchObject({
      schema: "web-doctor.contribution",
    });
    expect(result.files.has("policy.json")).toBe(true);
    await expect(fs.access(path.join(cache, "preinstall-ran"))).rejects.toThrow();
  });

  it("rejects a missing exact version", async () => {
    await expect(
      readInternalNpmArtifact({ ...source(), version: "9.9.9" }, ["web-doctor.json"], {
        registry,
        cache,
        allowInsecureRegistry: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects an integrity mismatch", async () => {
    const wrongIntegrity = String(ssri.fromData("wrong", { algorithms: ["sha512"] }));
    await expect(
      readInternalNpmArtifact({ ...source(), integrity: wrongIntegrity }, ["web-doctor.json"], {
        registry,
        cache,
        allowInsecureRegistry: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects alternate registry identities and unsafe paths before reading package contents", async () => {
    await expect(
      readInternalNpmArtifact({ ...source(), registry: "public" }, ["web-doctor.json"], {
        registry,
        cache,
        allowInsecureRegistry: true,
      }),
    ).rejects.toThrow();
    await expect(
      readInternalNpmArtifact(source(), ["../outside.json"], {
        registry,
        cache,
        allowInsecureRegistry: true,
      }),
    ).rejects.toThrow();
  });

  function source() {
    return {
      schema: "web-doctor.npm-source",
      schemaVersion: 1,
      registry: "internal",
      packageName: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      integrity,
      provenance: { repository: "ssh://git.internal/firm/artifact-fixture.git", commit: COMMIT },
    };
  }
});

async function buildTarball(files: Readonly<Record<string, string>>): Promise<Buffer> {
  const archive = pack();
  for (const [name, content] of Object.entries(files)) {
    archive.entry({ name: `package/${name}` }, content);
  }
  archive.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of archive) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("Tar stream emitted a non-byte chunk");
    chunks.push(Buffer.from(chunk));
  }
  return gzipSync(Buffer.concat(chunks));
}