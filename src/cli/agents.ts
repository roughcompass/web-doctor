import path from "node:path";
import { AGENT_CLIENTS, installAgents, uninstallAgents, type AgentClient, type RegistrationChange, type ServerLaunch } from "../agents/registration.js";
import { detectInstallationMode } from "../core/web-doctor.js";
import { discoverApplicationRoot } from "../facts/application-root.js";
import { CliUsageError, parseOptions, single } from "./options.js";
import type { CliContext, CliIo } from "./product.js";

/**
 * `web-doctor agent install|uninstall --client <name>`: registers the MCP
 * server with supported agent clients at the repository root and adds the
 * generated instruction. Only agent configuration changes, and only here.
 */
export async function runAgent(args: readonly string[], io: CliIo, context: CliContext): Promise<number> {
  const [action, ...rest] = args;
  if (action !== "install" && action !== "uninstall") throw new CliUsageError("Use agent install or agent uninstall");
  const parsed = parseOptions(rest, { values: ["--root", "--command"], repeatable: ["--client", "--portal"], flags: ["--json", "--allow-runtime"] });
  if (parsed.positionals.length > 0) throw new CliUsageError(`Unexpected argument ${parsed.positionals[0]}`);
  const clients = parsed.values.get("client") ?? [];
  if (clients.length === 0) throw new CliUsageError(`Name at least one --client: ${AGENT_CLIENTS.join(", ")}`);
  for (const client of clients) if (!(AGENT_CLIENTS as readonly string[]).includes(client)) throw new CliUsageError(`Unsupported client ${client}; supported clients are ${AGENT_CLIENTS.join(", ")}`);
  const root = single(parsed, "root");
  const application = await discoverApplicationRoot({ cwd: context.cwd, ...(root === undefined ? {} : { root }) });
  const configRoot = application.repositoryRoot ?? application.root;
  const selected = [...new Set(clients)] as AgentClient[];
  let changes: RegistrationChange[];
  let launch: ServerLaunch | null = null;
  if (action === "install") {
    const mode = await detectInstallationMode(application.root);
    const command = single(parsed, "command");
    const relative = path.relative(configRoot, application.root).split(path.sep).join("/");
    const serverArgs = [
      "mcp",
      ...(relative === "" ? [] : ["--root", relative]),
      ...(parsed.values.get("portal") ?? []).flatMap((portal) => ["--portal", portal]),
      ...(parsed.flags.has("allow-runtime") ? ["--allow-runtime"] : []),
    ];
    const project = mode === "project-exact" || mode === "project-range" || mode === "workspace";
    launch = command !== undefined ? { command, args: serverArgs } : project ? { command: "npx", args: ["--no-install", "web-doctor", ...serverArgs] } : { command: "web-doctor", args: serverArgs };
    changes = await installAgents({ root: configRoot, clients: selected, launch });
  } else {
    changes = await uninstallAgents({ root: configRoot, clients: selected });
  }
  if (parsed.flags.has("json")) io.stdout(`${JSON.stringify({ action, root: configRoot, launch, changes }, null, 2)}\n`);
  else for (const change of changes) io.stdout(`${change.action} ${change.file}${change.client === null ? "" : ` (${change.client})`}\n`);
  return 0;
}
