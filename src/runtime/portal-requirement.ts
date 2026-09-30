import type { RegistrySnapshot } from "../contracts/index.js";
import type { PortalSelectionResult } from "./portal-selection.js";

export interface PortalRequirementOptions {
  mode: "local" | "ci";
  required: boolean;
  selection: PortalSelectionResult;
  registry: RegistrySnapshot;
}

export interface PortalRequirementResult {
  status: "resolved" | "warning" | "error";
  complete: boolean;
  canContinue: boolean;
  exitCode: 0 | 2;
  portals: string[];
  claimsPortalConformance: false;
  message?: string;
}

export function evaluatePortalRequirement(options: PortalRequirementOptions): PortalRequirementResult {
  const selected = options.selection.status === "resolved" ? options.selection.portals : [];
  const active = new Set(options.registry.portals.filter((portal) => portal.lifecycle === "active").map((portal) => portal.id));
  const unknown = selected.filter((portal) => !active.has(portal));
  const problem = options.selection.status === "conflict"
    ? options.selection.message
    : unknown.length > 0
      ? `Unknown or inactive portal identity: ${unknown.join(", ")}`
      : options.required && selected.length === 0
        ? "Required portal identity is unresolved"
        : undefined;
  if (problem === undefined) {
    return {
      status: "resolved",
      complete: true,
      canContinue: true,
      exitCode: 0,
      portals: selected,
      claimsPortalConformance: false,
    };
  }
  const ci = options.mode === "ci";
  return {
    status: ci ? "error" : "warning",
    complete: false,
    canContinue: !ci,
    exitCode: ci ? 2 : 0,
    portals: selected,
    claimsPortalConformance: false,
    message: problem,
  };
}