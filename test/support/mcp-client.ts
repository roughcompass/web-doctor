import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { McpResponse } from "../../src/contracts/index.js";
import type { WebDoctor } from "../../src/core/web-doctor.js";
import { createWebDoctorServer } from "../../src/mcp.js";

/** An MCP protocol client connected in memory to a Web Doctor server over +core+. */
export async function connectClient(core: WebDoctor): Promise<{ client: Client; call: (name: string, input?: Record<string, unknown>) => Promise<McpResponse>; close: () => Promise<void> }> {
  const server = createWebDoctorServer(core);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "web-doctor-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    call: async (name, input = {}) => {
      const result = await client.callTool({ name, arguments: input });
      if (result.isError === true) throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content)}`);
      return result.structuredContent as McpResponse;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
