import { canonicalJson, digestDocument, type PolicyControl, type RegistrySnapshot } from "../contracts/index.js";
import { evaluateApplicability, type ApplicabilityFacts } from "./applicability.js";
import { resolvePortalSelection, type PortalSelectionInput, type PortalSelectionResult } from "./portal-selection.js";

export interface ControlDirective {
  controlId: string;
  action: "disable";
  layer: "portal" | "platform" | "application";
  exceptionId?: string;
  authorization?: string;
}

export interface PolicyCompositionOptions {
  registry: RegistrySnapshot;
  portalSelection?: PortalSelectionInput;
  facts?: Omit<ApplicabilityFacts, "portals">;
  directives?: readonly ControlDirective[];
}

export interface ComposedControl {
  control: PolicyControl;
  policyContribution: RegistrySnapshot["contributions"][number];
  policyId: string;
  layer: RegistrySnapshot["policies"][number]["layer"];
}

export interface ComposedPolicy {
  registryDigest: string;
  portals: string[];
  portalSelection: PortalSelectionResult;
  controls: ComposedControl[];
  contributions: RegistrySnapshot["contributions"];
  exceptions: string[];
  conflicts: string[];
  unresolvedApplicability: string[];
}

const LAYERS = ["firmwide", "portal", "platform", "application"] as const;
const STRENGTH = { informational: 0, recommended: 1, required: 2 } as const;

export function composePolicy(options: PolicyCompositionOptions): ComposedPolicy {
  const portalSelection = resolvePortalSelection(options.portalSelection ?? {});
  const portals = portalSelection.status === "resolved" ? portalSelection.portals : [];
  const facts: ApplicabilityFacts = {
    ...(options.facts ?? {}),
    ...(portalSelection.status === "resolved" ? { portals } : {}),
  };
  const controls = new Map<string, ComposedControl>();
  const contributions = new Map<string, RegistrySnapshot["contributions"][number]>();
  const conflicts = portalSelection.status === "conflict" ? [portalSelection.message] : [];
  const unresolvedApplicability = new Set<string>();
  const exceptions = new Set<string>();

  for (const layer of LAYERS) {
    for (const policy of options.registry.policies.filter((candidate) => candidate.layer === layer).sort((left, right) => left.id.localeCompare(right.id))) {
      const contribution = options.registry.contributions.find((candidate) => candidate.id === policy.id);
      if (contribution === undefined) {
        conflicts.push(`Policy ${policy.id} has no contribution provenance`);
        continue;
      }
      if (contribution.lifecycle === "retired") continue;
      const portalTargetUnresolved = layer === "portal" && portalSelection.status !== "resolved";
      if (
        layer === "portal"
        && portalSelection.status === "resolved"
        && !contribution.portals.some((portal) => portals.includes(portal))
      ) continue;
      for (const control of [...policy.controls].sort((left, right) => left.id.localeCompare(right.id))) {
        const applicability = evaluateApplicability(control.applicability, facts);
        if (applicability.status === "no-match") continue;
        if (applicability.status === "unresolved" || portalTargetUnresolved) unresolvedApplicability.add(control.id);
        const existing = controls.get(control.id);
        if (existing === undefined) {
          controls.set(control.id, { control, policyContribution: contribution, policyId: policy.id, layer });
          contributions.set(contribution.id, contribution);
          continue;
        }
        if (canonicalJson(existing.control) === canonicalJson(control)) continue;
        if (STRENGTH[control.strength] < STRENGTH[existing.control.strength]) {
          conflicts.push(`${layer} policy ${policy.id} cannot weaken ${control.id} from ${existing.control.strength} to ${control.strength}`);
        } else {
          conflicts.push(`Control ${control.id} has conflicting definitions in ${existing.policyId} and ${policy.id}`);
        }
      }
    }
  }

  for (const directive of options.directives ?? []) {
    const existing = controls.get(directive.controlId);
    if (existing === undefined) continue;
    const authorized = directive.exceptionId !== undefined
      && directive.authorization !== undefined
      && existing.control.exceptionPolicy === directive.authorization;
    if (authorized) {
      controls.delete(directive.controlId);
      exceptions.add(directive.exceptionId!);
      continue;
    }
    conflicts.push(`${directive.layer} directive cannot disable ${directive.controlId} without authorization from ${existing.policyId}`);
  }

  const composedControls = [...controls.values()].sort((left, right) => left.control.id.localeCompare(right.control.id));
  const usedContributionIds = new Set(composedControls.map((entry) => entry.policyContribution.id));
  return {
    registryDigest: digestDocument(options.registry).digest,
    portals,
    portalSelection,
    controls: composedControls,
    contributions: [...contributions.values()].filter((entry) => usedContributionIds.has(entry.id)).sort((left, right) => left.id.localeCompare(right.id)),
    exceptions: [...exceptions].sort(),
    conflicts: [...new Set(conflicts)].sort(),
    unresolvedApplicability: [...unresolvedApplicability].filter((id) => controls.has(id)).sort(),
  };
}