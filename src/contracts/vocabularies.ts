import * as z from "zod/v4";

export const POLICY_LAYERS = ["firmwide", "portal", "platform", "application"] as const;
export const REQUIREMENT_STRENGTHS = ["required", "recommended", "informational"] as const;
export const LIFECYCLES = ["active", "deprecated", "retired"] as const;
export const EVIDENCE_KINDS = ["static", "rendered", "measured", "manual"] as const;
export const FACT_CERTAINTIES = ["observed", "inferred", "unknown", "conflicting"] as const;
export const PROVIDER_COMPLETENESS = ["complete", "partial", "unavailable"] as const;
export const PROVIDER_CAPABILITIES = [
  "browser",
  "filesystem-read",
  "network-registry",
  "network-target",
  "process-spawn",
] as const;
export const FINDING_CLASSIFICATIONS = [
  "defect",
  "risk",
  "measurement_required",
  "manual_review",
  "unresolved",
] as const;
export const UPDATE_URGENCIES = ["none", "recommended", "required"] as const;
export const APPROVED_PATTERN_KINDS = [
  "component",
  "design-token",
  "api",
  "analytics-event",
  "runtime-integration",
  "content-term",
  "remediation",
] as const;

export const policyLayerSchema = z.enum(POLICY_LAYERS);
export const requirementStrengthSchema = z.enum(REQUIREMENT_STRENGTHS);
export const lifecycleSchema = z.enum(LIFECYCLES);
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export const factCertaintySchema = z.enum(FACT_CERTAINTIES);
export const providerCompletenessSchema = z.enum(PROVIDER_COMPLETENESS);
export const providerCapabilitySchema = z.enum(PROVIDER_CAPABILITIES);
export const findingClassificationSchema = z.enum(FINDING_CLASSIFICATIONS);
export const updateUrgencySchema = z.enum(UPDATE_URGENCIES);
export const approvedPatternKindSchema = z.enum(APPROVED_PATTERN_KINDS);

export type PolicyLayer = z.infer<typeof policyLayerSchema>;
export type RequirementStrength = z.infer<typeof requirementStrengthSchema>;
export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type FactCertainty = z.infer<typeof factCertaintySchema>;
export type ProviderCompleteness = z.infer<typeof providerCompletenessSchema>;
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type FindingClassification = z.infer<typeof findingClassificationSchema>;
export type UpdateUrgency = z.infer<typeof updateUrgencySchema>;
export type ApprovedPatternKind = z.infer<typeof approvedPatternKindSchema>;