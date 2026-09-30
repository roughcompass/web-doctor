#!/usr/bin/env node

import process from "node:process";
import { runCli } from "./cli-app.js";

runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  process.stderr.write(`Web Doctor failed: ${String(error)}\n`);
  process.exitCode = 1;
});