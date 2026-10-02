import process from "node:process";
import { recordRepoFactsRelease, writeRepoFactsRelease } from "../dist/index.js";

const output = process.argv[2] ?? "generated/repo-facts.json";
const release = await recordRepoFactsRelease({ root: "." });
await writeRepoFactsRelease(output, release);
process.stdout.write(`Recorded repo-facts ${release.release} (${release.commit}) in ${output}\n`);
