import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Provider workers run compiled modules, so tests need a current build.
 * Rebuilds only when a source file is newer than its compiled output.
 */
export default function setup(): void {
  const root = path.resolve(import.meta.dirname, "../..");
  if (!stale(path.join(root, "src"), path.join(root, "dist"))) return;
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
}

function stale(source: string, output: string): boolean {
  for (const entry of fs.readdirSync(source, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts")) continue;
    const compiled = path.join(output, entry.replace(/\.ts$/, ".js"));
    if (!fs.existsSync(compiled) || fs.statSync(compiled).mtimeMs < fs.statSync(path.join(source, entry)).mtimeMs) return true;
  }
  return false;
}
