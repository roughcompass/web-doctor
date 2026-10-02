import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { mcpResponseSchema, profileEvidenceSchema, type McpResponse, type ProfileEvidence } from "./contracts/index.js";
import { WebDoctor, type ContextQuery, type ScopeRequest, type WebDoctorOptions } from "./core/web-doctor.js";
import { runtimeRequestSchema, type RuntimeRequest } from "./diagnostics/runtime-request.js";
import { WEB_DOCTOR_VERSION } from "./version.js";

/**
 * One local MCP server over the shared application core. Tools are
 * question-oriented rather than one per detector; each returns the shared
 * response envelope as structured content and never edits source.
 */

const page = {
  limit: z.int().min(1).max(500).optional().describe("Maximum items in this page (default 50)"),
  continuation: z.string().min(1).optional().describe("Continuation from a previous truncated response"),
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Diagnostics read source and, when authorized, contact running local targets; they never write. */
const DIAGNOSTICS = { ...READ_ONLY, openWorldHint: true } as const;
const portals = z.array(z.string().min(1)).optional().describe("Portals for this request; overrides launch arguments");
const continuation = z.string().min(1).optional().describe("Continuation from a previous truncated response to this same request");

export function createWebDoctorServer(core: WebDoctor): McpServer {
  const server = new McpServer({ name: "web-doctor", version: WEB_DOCTOR_VERSION });
  const tool = <Shape extends z.ZodRawShape>(name: string, title: string, description: string, shape: Shape, handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<McpResponse>, annotations: typeof READ_ONLY | typeof DIAGNOSTICS = READ_ONLY) => {
    server.registerTool(name, { title, description, inputSchema: z.object(shape), outputSchema: mcpResponseSchema, annotations }, async (input) => {
      try {
        const response = await handler(input as z.infer<z.ZodObject<Shape>>);
        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  };

  tool(
    "project_overview",
    "Project Overview",
    "Summarize this application from evidence: shared repository facts from the pinned repo-facts release and Web Doctor's React extensions. Choose a topic for runtime boundaries, Service Dependencies, verification commands, or tests.",
    {
      topic: z.enum(["overview", "runtime_boundaries", "service_dependencies", "verification_commands", "tests"]).optional().describe("What to summarize (default overview)"),
      path: z.string().min(1).optional().describe("Limit Service Dependencies or tests to this path"),
      kind: z.string().min(1).optional().describe("Limit verification commands to this kind, such as test or build"),
      category: z.string().min(1).optional().describe("Limit runtime boundaries to one category"),
      ...page,
    },
    async (input) => core.context(overviewQuery(input), pageOf(input)),
  );

  tool(
    "explain_symbol",
    "Explain Symbol",
    "Explain a component, hook, context, or other top-level symbol by id (path#name) or name: its definition and props, its usages, how it receives data, or the tests that reach it.",
    {
      symbol: z.string().min(1).describe("Symbol id such as src/App.tsx#App, or a name"),
      aspect: z.enum(["definition", "usages", "data_path", "tests"]).optional().describe("What to explain (default definition)"),
      referenceKind: z.enum(["jsx", "call", "import", "export", "type", "value"]).optional().describe("Limit usages to one reference kind"),
      path: z.string().min(1).optional().describe("Limit usages to files under this path"),
      ...page,
    },
    async (input) => core.context(symbolQuery(input), pageOf(input)),
  );

  tool(
    "effective_guidance",
    "Effective Guidance",
    "Resolve the effective firmwide, portal, platform, and application policy for this application, optionally for one file, with conflicts, unresolved applicability, applicable registry guidance, and the approved enterprise patterns that apply to the file.",
    {
      portals,
      file: z.string().min(1).optional().describe("Application-relative file the guidance should apply to"),
      continuation,
    },
    async (input) => core.effectivePolicy({ ...(input.portals === undefined ? {} : { portals: input.portals }), ...(input.file === undefined ? {} : { file: input.file }), ...continued(input) }),
  );

  tool(
    "run_diagnostics",
    "Run Diagnostics",
    "Run the approved providers that effective policy requires, over the whole project, changed files, or named files, and report normalized findings, Control outcomes, provider completeness, and the gate. Rendered checks run only for an explicit runtime request and only when this server was started with --allow-runtime. Never edits source.",
    {
      portals,
      scope: z.enum(["full", "changed-files", "changed-lines", "files"]).optional().describe("What to check (default full)"),
      base: z.string().min(1).optional().describe("Base revision for changed-files or changed-lines"),
      files: z.array(z.string().min(1)).min(1).optional().describe("Application-relative files for scope files"),
      runtime: runtimeRequestSchema.optional().describe("Running local targets and states to check with rendered providers; authorized must be true"),
      gate: z.enum(["required", "recommended", "informational"]).optional().describe("Lowest Control strength that fails the gate"),
      continuation,
    },
    async (input) => core.runDiagnostics({
      ...(input.portals === undefined ? {} : { portals: input.portals }),
      ...continued(input),
      scope: scopeOf(input),
      ...(input.runtime === undefined ? {} : { runtime: input.runtime as RuntimeRequest }),
      ...(input.gate === undefined ? {} : { gate: input.gate }),
    }),
    DIAGNOSTICS,
  );

  tool(
    "explain_finding",
    "Explain Finding or Control",
    "Explain one finding from the latest diagnostics run: every Control obligation, the approved enterprise pattern that replaces generic remediation, the shared component that may own it, and verification. Pass control instead to explain a Control's definition, provenance, and latest outcome. Suggests changes; never makes them.",
    {
      finding: z.string().min(1).optional().describe("Finding id (finding_...) or fingerprint"),
      control: z.string().min(1).optional().describe("Control id, such as firm/accessibility/button-name"),
      portals,
      continuation,
    },
    async (input) => {
      if ((input.finding === undefined) === (input.control === undefined)) throw new Error("Pass exactly one of finding or control");
      const scoped = { ...(input.portals === undefined ? {} : { portals: input.portals }), ...continued(input) };
      return input.finding !== undefined ? core.explainFinding({ finding: input.finding, ...scoped }) : core.explainControl({ control: input.control!, ...scoped });
    },
  );

  tool(
    "plan_upgrade",
    "Plan Upgrade",
    "Plan an ordered, verifiable upgrade of a package from its installed version to a target: blockers first, preparation that works today, one stage per compatible intermediate release, rollback boundaries, and the narrowest verification per stage.",
    {
      package: z.string().min(1).optional().describe("Package to upgrade (default react)"),
      target: z.string().min(1).describe("Target version, such as 19 or 19.0.0"),
      continuation,
    },
    async (input) => core.planUpgrade({ package: input.package ?? "react", target: input.target, ...continued(input) }),
  );

  tool(
    "plan_verification",
    "Plan Verification",
    "List the verification the applicable Controls need: static checks, component tests, rendered states, interaction tests, measurements, and manual review, each satisfied only by its own evidence kind. Uses the latest diagnostics run and any supplied profile evidence.",
    {
      portals,
      files: z.array(z.string().min(1)).min(1).optional().describe("Application-relative files the change touches"),
      controls: z.array(z.string().min(1)).min(1).optional().describe("Limit the plan to these Controls"),
      measurements: z.array(z.object({ provider: z.string().min(1), profile: profileEvidenceSchema })).optional().describe("Profile evidence by the measuring provider it stands for"),
      continuation,
    },
    async (input) => core.planVerification({
      ...continued(input),
      ...(input.portals === undefined ? {} : { portals: input.portals }),
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(input.controls === undefined ? {} : { controls: input.controls }),
      ...(input.measurements === undefined ? {} : { measurements: input.measurements as { provider: string; profile: ProfileEvidence }[] }),
    }),
  );

  tool(
    "update_status",
    "Update Status",
    "Report whether a newer approved Web Doctor package is available and the exact upgrade path, without changing this process.",
    {},
    async () => core.updateStatus(),
  );

  tool(
    "build_provenance",
    "Web Doctor Build Provenance",
    "Return the exact package, registry snapshot, catalog, contribution, and repo-facts release inputs used by this process.",
    {},
    async () => core.respond("build_provenance", {}, null, null, core.build, { complete: true }),
  );

  return server;
}

export type StdioServerOptions = Omit<WebDoctorOptions, "caller">;

export async function runWebDoctorStdioServer(options: Partial<StdioServerOptions> = {}): Promise<void> {
  const configuredRoot = options.registryRoot ?? process.env.WEB_DOCTOR_REGISTRY_ROOT;
  const core = await WebDoctor.open({
    ...options,
    cwd: options.cwd ?? process.cwd(),
    caller: "mcp",
    ...(configuredRoot === undefined ? {} : { registryRoot: configuredRoot }),
  });
  serveStdio(() => createWebDoctorServer(core));
}

function continued(input: { continuation?: string | undefined }): { continuation?: string } {
  return input.continuation === undefined ? {} : { continuation: input.continuation };
}

function scopeOf(input: { scope?: string | undefined; base?: string | undefined; files?: string[] | undefined }): ScopeRequest {
  const scope = input.scope ?? (input.files !== undefined ? "files" : "full");
  if (scope === "files") {
    if (input.files === undefined) throw new Error("scope files needs files");
    return { mode: "files", files: input.files };
  }
  if (scope === "changed-files" || scope === "changed-lines") {
    if (input.base === undefined) throw new Error(`scope ${scope} needs base`);
    return { mode: scope, base: input.base };
  }
  return { mode: "full" };
}

function overviewQuery(input: { topic?: string | undefined; path?: string | undefined; kind?: string | undefined; category?: string | undefined }): ContextQuery {
  switch (input.topic ?? "overview") {
    case "runtime_boundaries":
      return { query: "runtime_boundaries", ...(input.category === undefined ? {} : { category: input.category }) };
    case "service_dependencies":
      return { query: "service_dependencies", ...(input.path === undefined ? {} : { path: input.path }) };
    case "verification_commands":
      return { query: "verification_commands", ...(input.kind === undefined ? {} : { kind: input.kind }) };
    case "tests":
      return { query: "tests", ...(input.path === undefined ? {} : { path: input.path }) };
    default:
      return { query: "project_overview" };
  }
}

function symbolQuery(input: { symbol: string; aspect?: string | undefined; referenceKind?: "jsx" | "call" | "import" | "export" | "type" | "value" | undefined; path?: string | undefined }): ContextQuery {
  switch (input.aspect ?? "definition") {
    case "usages":
      return { query: "usages", symbol: input.symbol, ...(input.referenceKind === undefined ? {} : { kind: input.referenceKind }), ...(input.path === undefined ? {} : { path: input.path }) };
    case "data_path":
      return { query: "data_path", symbol: input.symbol };
    case "tests":
      return { query: "tests", symbol: input.symbol };
    default:
      return { query: "explain_symbol", symbol: input.symbol };
  }
}

function pageOf(input: { limit?: number | undefined; continuation?: string | undefined }) {
  return { ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.continuation === undefined ? {} : { continuation: input.continuation }) };
}
