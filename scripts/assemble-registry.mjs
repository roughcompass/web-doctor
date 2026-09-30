import fs from "node:fs/promises";
import { assembleEmbeddedRegistry } from "../dist/index.js";

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) throw new Error("Arguments must be --name value pairs");
  argumentsByName.set(name.slice(2), value);
}

const snapshotPath = required("snapshot");
const contributionsRoot = required("contributions");
const outputRoot = required("output");
const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
const result = await assembleEmbeddedRegistry(snapshot, contributionsRoot, outputRoot);
process.stdout.write(`${result.files.length} embedded registry files\n`);

function required(name) {
  const value = argumentsByName.get(name);
  if (value === undefined) throw new Error(`Missing --${name}`);
  return value;
}