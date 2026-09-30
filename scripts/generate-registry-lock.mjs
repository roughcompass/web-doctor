import fs from "node:fs/promises";
import path from "node:path";
import {
  generateContributionLock,
  parseContract,
  writeContributionLock,
} from "../dist/index.js";

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) throw new Error("Arguments must be --name value pairs");
  argumentsByName.set(name.slice(2), value);
}

const catalogPath = required("catalog");
const manifestsPath = required("manifests");
const outputPath = required("output");
const catalog = parseContract("catalog", JSON.parse(await fs.readFile(catalogPath, "utf8")));
const manifestObject = JSON.parse(await fs.readFile(manifestsPath, "utf8"));
const manifests = new Map(Object.entries(manifestObject));
const lock = generateContributionLock(catalog, manifests);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await writeContributionLock(outputPath, lock);
process.stdout.write(`${outputPath}\n`);

function required(name) {
  const value = argumentsByName.get(name);
  if (value === undefined) throw new Error(`Missing --${name}`);
  return value;
}