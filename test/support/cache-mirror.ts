import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

/**
 * A local npm registry that serves only what the developer's npm cache
 * already holds: package metadata and exact tarballs, looked up by the URLs
 * they were fetched from. It stands in for the enterprise registry in tests,
 * so installs resolve real packages with their real integrity and no network.
 */

const execFileAsync = promisify(execFile);

interface Cacache {
  get: (cache: string, key: string) => Promise<{ data: Buffer }>;
}

export interface CacheMirror {
  url: string;
  /** Requests the cache could not answer, for diagnosing a failed install. */
  misses: string[];
  close: () => Promise<void>;
}

export async function startCacheMirror(upstreams: readonly string[]): Promise<CacheMirror> {
  const cacacheModule = "cacache";
  const cacache = ((await import(cacacheModule)) as { default: Cacache }).default;
  const cache = `${(await execFileAsync("npm", ["config", "get", "cache"])).stdout.trim()}/_cacache`;
  const registries = upstreams.map((upstream) => (upstream.endsWith("/") ? upstream : `${upstream}/`));
  const misses: string[] = [];
  const lookup = async (url: string): Promise<Buffer | null> => {
    try {
      return (await cacache.get(cache, `make-fetch-happen:request-cache:${url}`)).data;
    } catch {
      return null;
    }
  };
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://mirror.test").pathname;
      if (pathname.startsWith("/-/tarball/")) {
        const original = Buffer.from(pathname.slice("/-/tarball/".length).replace(/\.tgz$/, ""), "base64url").toString("utf8");
        const body = await lookup(original);
        if (body === null) return miss(response, original);
        response.setHeader("content-type", "application/octet-stream");
        return response.end(body);
      }
      const name = decodeURIComponent(pathname.slice(1));
      for (const registry of registries) {
        for (const encoded of [name.replace("/", "%2f"), name.replace("/", "%2F"), name]) {
          const body = await lookup(`${registry}${encoded}`);
          if (body === null) continue;
          const packument = JSON.parse(body.toString("utf8")) as { versions?: Record<string, { dist?: { tarball?: string } }> };
          for (const version of Object.values(packument.versions ?? {})) {
            if (version.dist?.tarball !== undefined) version.dist.tarball = `${origin}/-/tarball/${Buffer.from(version.dist.tarball).toString("base64url")}.tgz`;
          }
          response.setHeader("content-type", "application/json");
          return response.end(JSON.stringify(packument));
        }
      }
      return miss(response, name);
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  const miss = (response: import("node:http").ServerResponse, subject: string) => {
    misses.push(subject);
    response.statusCode = 404;
    response.end("{}");
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${origin}/`, misses, close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) };
}
