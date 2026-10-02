import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// Copies repo-facts golden fixtures from a checkout at the pinned release's
// source commit, so Web Doctor tests compare against the documents that
// release was reviewed with.
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: node scripts/sync-repo-facts-fixtures.mjs <repo-facts checkout>");

const provenance = JSON.parse(await fs.readFile("node_modules/@repo-facts/bundle/provenance.json", "utf8"));
const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== provenance.commit) throw new Error(`${checkout} is at ${head}, not the pinned release commit ${provenance.commit}`);
const dirty = execFileSync("git", ["-C", checkout, "status", "--porcelain", "--", "fixtures"], { encoding: "utf8" });
if (dirty.trim() !== "") throw new Error(`${checkout}/fixtures has uncommitted changes`);

const destination = "test/fixtures/repo-facts";
await fs.rm(destination, { recursive: true, force: true });
await fs.cp(path.join(checkout, "fixtures"), destination, { recursive: true, verbatimSymlinks: true });
const source = { repository: "repo-facts", commit: provenance.commit, release: provenance.version };
await fs.writeFile(path.join(destination, "SOURCE.json"), `${JSON.stringify(source, null, 2)}\n`, "utf8");
process.stdout.write(`Synced repo-facts fixtures from ${provenance.commit}\n`);
