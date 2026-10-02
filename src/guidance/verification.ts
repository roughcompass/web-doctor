import { type DocumentFact, compareCodeUnits } from "@repo-facts/contract";
import {
  stableIdentifier,
  type DiagnosticsReport,
  type EffectivePolicySnapshot,
  type EvidenceKind,
  type PolicyControl,
  type PolicyLayer,
  type ProfileEvidence,
  type RequirementStrength,
} from "../contracts/index.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import { factView, type FactView } from "../facts/queries.js";
import { evaluateApplicability } from "../runtime/applicability.js";
import { declaredCommand } from "./commands.js";

/**
 * Verification planning across static checks, component tests, rendered
 * states, interaction tests, measurements, and manual review. Each required
 * evidence entry of a Control is satisfied only by evidence of its own kind:
 * a complete static run for static evidence, a complete rendered run over
 * tested states for rendered evidence, supplied profile evidence for
 * measured evidence, and nothing Web Doctor can produce for manual review.
 * Tests are named and located but never run, so they never satisfy evidence.
 */

export type VerificationType = "static" | "component-test" | "rendered" | "interaction-test" | "measurement" | "manual";

export interface VerificationItem {
  id: string;
  type: VerificationType;
  controls: string[];
  /** The evidence kind this item provides for a Control, or null when it only supports verification. */
  evidenceKind: EvidenceKind | null;
  provider: string | null;
  rule: string | null;
  required: boolean;
  description: string;
  command: string | null;
  targets: string[];
  status: "satisfied" | "failed" | "remaining";
  reason: string;
  evidence: FactView[];
}

export interface ControlVerification {
  control: string;
  title: string;
  strength: RequirementStrength;
  layer: PolicyLayer | null;
  requires: EvidenceKind[];
  satisfied: EvidenceKind[];
  status: "verified" | "failed" | "remaining";
  remaining: string[];
}

export interface VerificationPlan {
  items: VerificationItem[];
  controls: ControlVerification[];
  complete: boolean;
  statement: string;
  policyDigest: string;
  reportDigest: string | null;
  modifiesProject: false;
}

export interface VerificationRequest {
  policy: EffectivePolicySnapshot;
  layers: ReadonlyMap<string, PolicyLayer>;
  snapshot: ProjectSnapshot;
  /** The latest diagnostics report under the same effective policy, if any. */
  report?: DiagnosticsReport | null;
  /** Profile evidence by the measuring provider it stands for. */
  measurements?: readonly { provider: string; profile: ProfileEvidence }[];
  files?: readonly string[];
  controls?: readonly string[];
}

const TYPE_ORDER: readonly VerificationType[] = ["static", "component-test", "rendered", "interaction-test", "measurement", "manual"];
const INTERACTION_FRAMEWORKS = new Set(["@playwright/test", "playwright", "cypress", "puppeteer", "webdriverio"]);

export function planVerification(request: VerificationRequest): VerificationPlan {
  const { policy, snapshot } = request;
  const report = request.report !== undefined && request.report !== null && request.report.policyDigest === policy.digest ? request.report : null;
  const files = [...new Set(request.files ?? [])].sort(compareCodeUnits);
  const outcomes = new Map((report?.controls ?? []).map((outcome) => [outcome.control, outcome]));
  const tested = [...new Set((report?.runs ?? []).flatMap((run) => run.testedScope))].sort(compareCodeUnits);
  const extensions = snapshot.extensions.document;
  const shared = snapshot.shared.status === "complete" ? snapshot.shared.document : null;
  const allTests = snapshot.extensions.categories["web-doctor.tests"]?.facts ?? [];
  // Component tests import what they test; interaction tests drive the running application, so none is narrowed by file.
  const componentTests = allTests.filter((fact) => !interaction(fact) && (files.length === 0 || subjectsOf(fact).some((subject) => files.includes(subject)) || files.includes(fact.key)));
  const interactionTests = allTests.filter(interaction);
  const routeFacts = (snapshot.extensions.categories["web-doctor.routes"]?.facts ?? []).filter((fact) => files.length === 0 || files.includes(String((fact.value as { module?: unknown }).module)));
  const commandFor = (type: VerificationType) => (shared === null ? null : type === "component-test" ? declaredCommand(shared, "test") : type === "interaction-test" ? declaredCommand(shared, "e2e") : null);

  const selected = policy.controls.filter((entry) => {
    if (request.controls !== undefined) return request.controls.includes(entry.control.id);
    if (files.length === 0 || entry.control.applicability.files === undefined) return true;
    return files.some((file) => evaluateApplicability({ files: entry.control.applicability.files }, { file }).status === "match");
  });

  const items = new Map<string, VerificationItem>();
  const add = (item: Omit<VerificationItem, "id">, control: string): string => {
    const id = stableIdentifier("verify", { type: item.type, evidenceKind: item.evidenceKind, provider: item.provider, rule: item.rule, description: item.description, targets: item.targets });
    const existing = items.get(id);
    if (existing === undefined) items.set(id, { ...item, id, controls: [control] });
    else {
      if (!existing.controls.includes(control)) existing.controls.push(control);
      existing.required ||= item.required;
    }
    return id;
  };

  const controls: ControlVerification[] = [];
  for (const entry of selected) {
    const control = entry.control;
    const outcome = outcomes.get(control.id);
    const own: { id: string; required: boolean; kind: EvidenceKind | null }[] = [];
    for (const requirement of control.evidence) {
      const recorded = outcome?.evidence.find((item) => item.provider === requirement.provider && item.kind === requirement.kind && (requirement.rule === undefined || item.rule === requirement.rule || item.rule?.endsWith(`/${requirement.rule}`) === true));
      const label = `${requirement.provider}${requirement.rule === undefined ? "" : ` ${requirement.rule}`}`;
      let item: Omit<VerificationItem, "id">;
      if (requirement.kind === "static") {
        const status = recorded === undefined ? "remaining" : recorded.findings > 0 ? "failed" : recorded.status === "complete" ? "satisfied" : "remaining";
        item = { type: "static", controls: [], evidenceKind: "static", provider: requirement.provider, rule: requirement.rule ?? null, required: requirement.required, description: `Run ${label}`, command: files.length === 0 ? "web-doctor check" : `web-doctor check --files ${files.join(" ")}`, targets: files, status, reason: reasonOf(status, recorded?.status ?? null, "static"), evidence: [] };
      } else if (requirement.kind === "rendered") {
        const status = recorded === undefined || tested.length === 0 ? "remaining" : recorded.findings > 0 ? "failed" : recorded.status === "complete" ? "satisfied" : "remaining";
        item = { type: "rendered", controls: [], evidenceKind: "rendered", provider: requirement.provider, rule: requirement.rule ?? null, required: requirement.required, description: `Check ${label} in rendered states`, command: "web-doctor check --runtime <request.json>", targets: status === "remaining" ? routesOf(routeFacts) : tested, status, reason: status === "satisfied" ? `Complete in the tested states: ${tested.join("; ")}` : reasonOf(status, recorded?.status ?? null, "rendered"), evidence: routeFacts.map((fact) => factView("extension", extensions, "web-doctor.routes", fact)) };
      } else if (requirement.kind === "measured") {
        const measurement = (request.measurements ?? []).find((candidate) => candidate.provider === requirement.provider);
        const over = measurement?.profile.components.filter((component) => component.maxCommitMs >= measurement.profile.commitBudgetMs) ?? [];
        const status = measurement === undefined ? "remaining" : over.length > 0 ? "failed" : "satisfied";
        item = { type: "measurement", controls: [], evidenceKind: "measured", provider: requirement.provider, rule: requirement.rule ?? null, required: requirement.required, description: measurement === undefined ? `Measure with ${label} and supply the profile` : `Profile "${measurement.profile.interaction}"`, command: null, targets: measurement === undefined ? [] : [measurement.profile.interaction], status, reason: measurement === undefined ? "No profile evidence was supplied; static and rendered checks do not measure cost" : over.length > 0 ? `${over.map((component) => component.component).join(", ")} exceeded the ${measurement.profile.commitBudgetMs} ms commit budget` : `Every profiled component stayed under the ${measurement.profile.commitBudgetMs} ms commit budget`, evidence: [] };
      } else {
        item = { type: "manual", controls: [], evidenceKind: "manual", provider: requirement.provider, rule: null, required: requirement.required, description: `Review by ${requirement.provider}`, command: null, targets: files, status: "remaining", reason: "Manual review cannot be satisfied by automated checks or tests", evidence: [] };
      }
      own.push({ id: add(item, control.id), required: requirement.required, kind: requirement.kind });
    }
    for (const verification of control.verification) {
      const type = typeOf(verification.kind);
      if (type === "static" || type === "rendered") continue;
      if (type === "measurement" && control.evidence.some((requirement) => requirement.kind === "measured")) continue;
      const tests = type === "component-test" ? componentTests : type === "interaction-test" ? interactionTests : [];
      const declared = commandFor(type);
      const id = add({
        type,
        controls: [],
        evidenceKind: type === "manual" && control.evidence.some((requirement) => requirement.kind === "manual") ? "manual" : null,
        provider: null,
        rule: null,
        required: false,
        description: verification.description,
        command: declared === null ? null : declared.command ?? declared.declared,
        targets: tests.length > 0 ? tests.map((fact) => fact.key) : files,
        status: "remaining",
        reason: type === "component-test" || type === "interaction-test" ? (tests.length === 0 ? "No indexed test covers the target files" : "Web Doctor names tests but does not run them") : type === "measurement" ? "No measurement was supplied" : "Manual review cannot be satisfied by automated checks or tests",
        evidence: [...tests.map((fact) => factView("extension", extensions, "web-doctor.tests", fact)), ...(declared === null ? [] : [declared.evidence])],
      }, control.id);
      own.push({ id, required: false, kind: null });
    }
    for (const obligation of outcome?.obligations ?? []) {
      if (obligation.kind !== "untested-states" && obligation.source === control.id) continue;
      const type = obligation.kind === "untested-states" ? "rendered" : typeOf(obligation.kind);
      const id = add({ type, controls: [], evidenceKind: null, provider: null, rule: null, required: false, description: obligation.description, command: null, targets: [], status: "remaining", reason: `Remaining after the last run (${obligation.source})`, evidence: [] }, control.id);
      own.push({ id, required: false, kind: null });
    }
    controls.push(verdict(control, request.layers.get(control.id) ?? null, own, items));
  }

  const ordered = [...items.values()].map((item) => ({ ...item, controls: item.controls.sort(compareCodeUnits) })).sort((left, right) => TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type) || Number(right.required) - Number(left.required) || compareCodeUnits(left.description, right.description) || compareCodeUnits(left.id, right.id));
  const remaining = controls.filter((control) => control.status !== "verified");
  const manual = controls.filter((control) => control.requires.includes("manual")).length;
  const statement = remaining.length === 0
    ? `Every selected Control has its required evidence${tested.length > 0 ? `; rendered evidence covers only the tested states (${tested.join("; ")})` : ""}`
    : `${remaining.length} of ${controls.length} Controls still need evidence${manual > 0 ? `, including manual review for ${manual}` : ""}; passing automated checks does not establish conformance`;
  return { items: ordered, controls: controls.sort((left, right) => compareCodeUnits(left.control, right.control)), complete: remaining.length === 0, statement, policyDigest: policy.digest, reportDigest: report?.digest ?? null, modifiesProject: false };
}

function verdict(control: PolicyControl, layer: PolicyLayer | null, own: readonly { id: string; required: boolean; kind: EvidenceKind | null }[], items: ReadonlyMap<string, VerificationItem>): ControlVerification {
  const required = own.filter((item) => item.required && item.kind !== null);
  const statusOf = (id: string) => items.get(id)!.status;
  const status = required.some((item) => statusOf(item.id) === "failed") ? "failed" : required.every((item) => statusOf(item.id) === "satisfied") ? "verified" : "remaining";
  return {
    control: control.id,
    title: control.title,
    strength: control.strength,
    layer,
    requires: [...new Set(required.map((item) => item.kind!))].sort(compareCodeUnits),
    satisfied: [...new Set(required.filter((item) => statusOf(item.id) === "satisfied").map((item) => item.kind!))].sort(compareCodeUnits),
    status,
    remaining: [...new Set(own.filter((item) => statusOf(item.id) !== "satisfied").map((item) => item.id))],
  };
}

function reasonOf(status: VerificationItem["status"], recorded: string | null, kind: "static" | "rendered"): string {
  if (status === "failed") return "The last run reported findings for this evidence";
  if (status === "satisfied") return "The last run completed with no findings";
  if (recorded === null || recorded === "not_run") return kind === "rendered" ? "No rendered run under this policy has tested a state" : "No run under this policy has produced this evidence";
  return `The last run's evidence was ${recorded.replaceAll("_", " ")}`;
}

function typeOf(kind: string): VerificationType {
  const normalized = kind.toLowerCase();
  if (["eslint", "lint", "static", "typecheck"].includes(normalized)) return "static";
  if (["axe", "rendered", "runtime"].includes(normalized)) return "rendered";
  if (["test", "unit", "component", "component-test"].includes(normalized)) return "component-test";
  if (["interaction", "interaction-test", "e2e", "playwright", "cypress"].includes(normalized)) return "interaction-test";
  if (["profile", "measure", "measurement", "performance"].includes(normalized)) return "measurement";
  return "manual";
}

function interaction(fact: DocumentFact): boolean {
  const value = fact.value as { imports_framework?: unknown };
  return (typeof value.imports_framework === "string" && INTERACTION_FRAMEWORKS.has(value.imports_framework)) || /(^|\/)e2e\//.test(fact.key);
}

function routesOf(facts: readonly DocumentFact[]): string[] {
  return [...new Set(facts.flatMap((fact) => {
    const path = (fact.value as { path?: { kind?: string; value?: string } | null }).path;
    return path?.kind === "literal" && path.value !== undefined ? [path.value] : [];
  }))].sort(compareCodeUnits);
}

function subjectsOf(fact: DocumentFact): string[] {
  const subjects = (fact.value as { subjects?: unknown }).subjects;
  return Array.isArray(subjects) ? subjects.filter((subject): subject is string => typeof subject === "string") : [];
}

