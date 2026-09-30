#!/usr/bin/env node

import process from "node:process";
import { runWebDoctorStdioServer } from "./mcp.js";

runWebDoctorStdioServer().catch((error: unknown) => {
  process.stderr.write(`Web Doctor MCP server failed: ${String(error)}\n`);
  process.exitCode = 1;
});