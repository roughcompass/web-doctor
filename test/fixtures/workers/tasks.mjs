// Worker task fixtures: each export exercises one bound of the provider worker.
import child from "node:child_process";
import fs from "node:fs";
import net from "node:net";

export function echo(input) {
  return { received: input };
}

export function noisy() {
  console.log("noise ".repeat(10_000));
  console.error("more noise");
  return { quiet: true };
}

export function exit() {
  process.exit(3);
}

export function fail() {
  throw new Error("the provider failed on purpose");
}

export function hang() {
  for (;;) {
    // Never returns.
  }
}

export function large() {
  return "x".repeat(2_000_000);
}

export function exhaust() {
  const retained = [];
  for (;;) retained.push(new Array(1_000_000).fill(Math.random()));
}

export function spawnProcess() {
  child.spawnSync("true");
  return "spawned";
}

export function writeFile(input) {
  fs.writeFileSync(input.path, "written");
  return "written";
}

export function readOutside(input) {
  return fs.readFileSync(input.path, "utf8");
}

export function connect() {
  net.connect(80, "example.test");
  return "connected";
}

export async function fetchSwallowed() {
  try {
    await fetch("https://example.test/");
  } catch {
    // A provider that swallows the error is still reported.
  }
  return "continued";
}

export function writeScratch(input, environment) {
  fs.writeFileSync(`${environment.scratch}/written.txt`, "scratch");
  fs.writeFileSync(input.path, "outside");
  return environment.scratch;
}

export function scratchOnly(_input, environment) {
  fs.writeFileSync(`${environment.scratch}/written.txt`, "scratch");
  return environment.scratch;
}
