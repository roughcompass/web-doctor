import fs from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import {
  contributionFixtureSchema,
  providerManifestSchema,
  schemaFor,
  type ProviderManifest,
} from "../contracts/index.js";
import { builtinRules } from "eslint/use-at-your-own-risk";
import { BUILTIN_ESLINT } from "../diagnostics/providers.js";
import { WEB_DOCTOR_VERSION } from "../version.js";

export interface PolicyValidationIssue {
  code: "schema" | "namespace" | "applicability" | "provider_reference" | "compatibility" | "fixture";
  path: string;
  message: string;
}

export interface PolicyValidationOptions {
  policyPath: string;
  fixturePaths?: readonly string[];
  providerPaths?: readonly string[];
}

export interface PolicyValidationReport {
  valid: boolean;
  issues: PolicyValidationIssue[];
  fixtures: number;
}

export async function validatePolicyAuthoring(options: PolicyValidationOptions): Promise<PolicyValidationReport> {
  const issues: PolicyValidationIssue[] = [];
  const providers = await readProviders(options.providerPaths ?? [], issues);
  const policyInput = await readJson(options.policyPath);
  validatePolicyDocument(policyInput, "policy", providers, issues);

  for (const fixturePath of options.fixturePaths ?? []) {
    const fixtureInput = await readJson(fixturePath);
    const parsedFixture = contributionFixtureSchema.safeParse(fixtureInput);
    if (!parsedFixture.success) {
      addSchemaIssues(parsedFixture.error.issues, `fixtures.${fixturePath}`, "fixture", issues);
      continue;
    }
    const fixture = parsedFixture.data;
    if (fixture.contract !== "policyPack") {
      add(issues, "fixture", `fixtures.${fixture.id}.contract`, "Policy validation fixtures must target policyPack");
      continue;
    }
    const fixtureIssues: PolicyValidationIssue[] = [];
    try {
      validatePolicyDocument(
        await readJson(path.resolve(path.dirname(options.policyPath), fixture.input)),
        `fixtures.${fixture.id}.input`,
        providers,
        fixtureIssues,
      );
    } catch (error) {
      add(fixtureIssues, "schema", `fixtures.${fixture.id}.input`, messageFrom(error));
    }
    const accepted = fixtureIssues.length === 0;
    if ((fixture.expected === "accept") !== accepted) {
      add(issues, "fixture", `fixtures.${fixture.id}`, `Fixture expected ${fixture.expected} but was ${accepted ? "accepted" : "rejected"}`);
    }
  }

  issues.sort((left, right) => `${left.code}\0${left.path}\0${left.message}`.localeCompare(`${right.code}\0${right.path}\0${right.message}`));
  return { valid: issues.length === 0, issues, fixtures: options.fixturePaths?.length ?? 0 };
}

function validatePolicyDocument(
  input: unknown,
  root: string,
  providers: ReadonlyMap<string, ProviderManifest>,
  issues: PolicyValidationIssue[],
): void {
  const parsed = schemaFor("policyPack", isRecord(input) && typeof input.schemaVersion === "number" ? input.schemaVersion : undefined).safeParse(input);
  if (!parsed.success) addSchemaIssues(parsed.error.issues, root, "schema", issues);
  if (!isRecord(input)) return;

  const policyId = typeof input.id === "string" ? input.id : undefined;
  const controls = Array.isArray(input.controls) ? input.controls : [];
  const controlIds = new Set<string>();
  for (const [controlIndex, value] of controls.entries()) {
    if (!isRecord(value)) continue;
    const controlPath = `${root}.controls.${controlIndex}`;
    if (typeof value.id === "string") {
      if (policyId !== undefined && !value.id.startsWith(`${policyId}/`)) {
        add(issues, "namespace", `${controlPath}.id`, `Control ${value.id} must be inside policy namespace ${policyId}`);
      }
      if (controlIds.has(value.id)) add(issues, "namespace", `${controlPath}.id`, `Duplicate Control id ${value.id}`);
      controlIds.add(value.id);
    }
    validateApplicability(value.applicability, `${controlPath}.applicability`, issues);
    if (Array.isArray(value.evidence)) {
      for (const [evidenceIndex, evidence] of value.evidence.entries()) {
        if (!isRecord(evidence) || typeof evidence.provider !== "string") continue;
        const evidencePath = `${controlPath}.evidence.${evidenceIndex}`;
        // Manual evidence names a reviewer, not an executable provider.
        if (evidence.kind === "manual") continue;
        if (evidence.provider === BUILTIN_ESLINT && !providers.has(BUILTIN_ESLINT)) {
          validateBuiltinEslint(evidence, evidencePath, providers, issues);
          continue;
        }
        const provider = providers.get(evidence.provider);
        if (provider === undefined) {
          add(issues, "provider_reference", `${evidencePath}.provider`, `Unknown provider ${evidence.provider}`);
          continue;
        }
        if (typeof evidence.rule === "string") {
          const rule = provider.rules.find((candidate) => candidate.id === evidence.rule);
          if (rule === undefined) add(issues, "provider_reference", `${evidencePath}.rule`, `Provider ${provider.id} does not declare rule ${evidence.rule}`);
          else if (typeof evidence.kind === "string" && rule.evidenceKind !== evidence.kind) {
            add(issues, "provider_reference", `${evidencePath}.kind`, `Rule ${evidence.rule} produces ${rule.evidenceKind} evidence, not ${evidence.kind}`);
          }
        }
      }
    }
  }

  const range = isRecord(input.compatibility) && typeof input.compatibility.webDoctor === "string"
    ? input.compatibility.webDoctor
    : undefined;
  if (range !== undefined) {
    if (semver.validRange(range) === null) add(issues, "compatibility", `${root}.compatibility.webDoctor`, `Invalid Web Doctor range ${range}`);
    else if (!semver.satisfies(WEB_DOCTOR_VERSION, range)) {
      add(issues, "compatibility", `${root}.compatibility.webDoctor`, `Web Doctor ${WEB_DOCTOR_VERSION} is outside ${range}`);
    }
  }
}

function validateApplicability(input: unknown, root: string, issues: PolicyValidationIssue[]): void {
  if (!isRecord(input)) return;
  if (isRecord(input.files)) {
    for (const key of ["include", "exclude"] as const) {
      const patterns = input.files[key];
      if (!Array.isArray(patterns)) continue;
      for (const [index, pattern] of patterns.entries()) {
        if (typeof pattern === "string" && (pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").includes(".."))) {
          add(issues, "applicability", `${root}.files.${key}.${index}`, "File patterns must be relative normalized POSIX globs");
        }
      }
    }
  }
  for (const predicate of ["capabilities", "dependencies", "runtimes"] as const) {
    if (!Array.isArray(input[predicate])) continue;
    for (const [index, requirement] of input[predicate].entries()) {
      if (isRecord(requirement) && typeof requirement.range === "string" && semver.validRange(requirement.range) === null) {
        add(issues, "applicability", `${root}.${predicate}.${index}.range`, `Invalid ${predicate} range ${requirement.range}`);
      }
    }
  }
}

/**
 * The built-in `eslint` provider runs ESLint's core rules as static evidence.
 * A namespaced rule, such as `wealth-design/use-button`, belongs to the
 * approved plugin with that namespace, which must be supplied.
 */
function validateBuiltinEslint(evidence: Record<string, unknown>, evidencePath: string, providers: ReadonlyMap<string, ProviderManifest>, issues: PolicyValidationIssue[]): void {
  if (evidence.kind !== "static") add(issues, "provider_reference", `${evidencePath}.kind`, `ESLint rules produce static evidence, not ${String(evidence.kind)}`);
  const rule = evidence.rule;
  if (typeof rule !== "string") return;
  const slash = rule.indexOf("/");
  if (slash === -1) {
    if (!builtinRules.has(rule)) add(issues, "provider_reference", `${evidencePath}.rule`, `ESLint has no core rule ${rule}`);
    return;
  }
  const [namespace, name] = [rule.slice(0, slash), rule.slice(slash + 1)];
  const plugin = providers.get(namespace);
  if (plugin === undefined) add(issues, "provider_reference", `${evidencePath}.rule`, `Unknown ESLint plugin ${namespace}`);
  else if (!plugin.rules.some((candidate) => candidate.id === name)) add(issues, "provider_reference", `${evidencePath}.rule`, `Provider ${plugin.id} does not declare rule ${name}`);
}

async function readProviders(paths: readonly string[], issues: PolicyValidationIssue[]): Promise<Map<string, ProviderManifest>> {
  const providers = new Map<string, ProviderManifest>();
  for (const providerPath of paths) {
    const parsed = providerManifestSchema.safeParse(await readJson(providerPath));
    if (!parsed.success) {
      addSchemaIssues(parsed.error.issues, `providers.${providerPath}`, "provider_reference", issues);
      continue;
    }
    providers.set(parsed.data.id, parsed.data);
  }
  return providers;
}

function addSchemaIssues(
  zodIssues: readonly { path: PropertyKey[]; message: string }[],
  root: string,
  code: PolicyValidationIssue["code"],
  issues: PolicyValidationIssue[],
): void {
  for (const issue of zodIssues) add(issues, code, [root, ...issue.path.map(String)].join("."), issue.message);
}

function add(issues: PolicyValidationIssue[], code: PolicyValidationIssue["code"], issuePath: string, message: string): void {
  issues.push({ code, path: issuePath, message });
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}