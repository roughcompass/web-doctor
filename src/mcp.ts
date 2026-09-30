import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { BuildProvenance } from "./runtime/provenance.js";
import { buildBuildProvenance } from "./runtime/provenance.js";
import { WebDoctorRuntime } from "./runtime/runtime.js";
import { WEB_DOCTOR_VERSION } from "./version.js";

export function createWebDoctorServer(provenance?: BuildProvenance): McpServer {
  const server = new McpServer({
    name: "web-doctor",
    version: WEB_DOCTOR_VERSION,
  });
  if (provenance !== undefined) {
    server.registerTool(
      "build_provenance",
      {
        title: "Web Doctor Build Provenance",
        description: "Return the exact package, registry snapshot, catalog, and contribution inputs used by this process.",
      },
      async () => ({
        content: [{ type: "text", text: JSON.stringify(provenance) }],
        structuredContent: { ...provenance },
      }),
    );
  }
  return server;
}

export async function runWebDoctorStdioServer(): Promise<void> {
  const configuredRoot = process.env.WEB_DOCTOR_REGISTRY_ROOT;
  const runtime = await WebDoctorRuntime.create(configuredRoot === undefined ? {} : { root: configuredRoot });
  const provenance = buildBuildProvenance(runtime.registry.snapshot);
  await serveStdio(() => createWebDoctorServer(provenance));
}