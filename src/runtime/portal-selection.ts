import { identifierSchema } from "../contracts/index.js";

export type PortalSource = "cli" | "mcp" | "repository" | "assignment";

export interface PortalSelectionInput {
  cli?: readonly string[];
  mcp?: readonly string[];
  repository?: readonly string[];
  assignment?: readonly string[];
}

export interface PortalSourceSelection {
  source: PortalSource;
  portals: string[];
}

export type PortalSelectionResult =
  | { status: "resolved"; portals: string[]; source: PortalSource; sources: PortalSourceSelection[] }
  | { status: "unresolved"; portals: []; sources: [] }
  | { status: "conflict"; portals: []; sources: PortalSourceSelection[]; message: string };

const PRECEDENCE: readonly PortalSource[] = ["cli", "mcp", "repository", "assignment"];

export function resolvePortalSelection(input: PortalSelectionInput): PortalSelectionResult {
  const sources = PRECEDENCE.flatMap((source): PortalSourceSelection[] => {
    const values = input[source];
    if (values === undefined || values.length === 0) return [];
    const portals = [...new Set(values.map((value) => identifierSchema.parse(value)))].sort();
    return portals.length === 0 ? [] : [{ source, portals }];
  });
  if (sources.length === 0) return { status: "unresolved", portals: [], sources: [] };

  const selected = sources[0]!;
  const selectedKey = selected.portals.join("\0");
  const conflicting = sources.filter((source) => source.portals.join("\0") !== selectedKey);
  if (conflicting.length > 0) {
    // Command-line and MCP arguments are both explicit selections; naming them alike keeps the
    // message, and any policy digest that records it, the same from either surface.
    const details = sources.map((source) => `${source.source === "cli" || source.source === "mcp" ? "explicit" : source.source}=[${source.portals.join(", ")}]`).join("; ");
    return {
      status: "conflict",
      portals: [],
      sources,
      message: `Portal sources disagree: ${details}`,
    };
  }
  return { status: "resolved", portals: selected.portals, source: selected.source, sources };
}