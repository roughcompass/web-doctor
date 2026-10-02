import { type DocumentFact, type FactDocument, compareCodeUnits } from "@repo-facts/contract";
import semver from "semver";
import type { RegistrySnapshot, RepositoryConfig } from "../contracts/index.js";
import { policyFactsFor } from "../core/policy-facts.js";
import type { ProjectIndex } from "../facts/project-index.js";
import type { ProjectSnapshot } from "../facts/project-snapshot.js";
import { factView, type FactView } from "../facts/queries.js";
import { evaluateApplicability } from "../runtime/applicability.js";
import { PACKAGE_MANAGER_COMMANDS, declaredCommand, packageManagerOf } from "./commands.js";
import { UPGRADE_KNOWLEDGE, knowledgeDigest, type UpgradeChange, type UpgradeKnowledge } from "./upgrade-knowledge.js";

/**
 * An ordered, verifiable upgrade plan. Versions, lockfile resolutions,
 * runtime requirements, the package manager, and verification commands cite
 * the shared fact document. API usages cite Web Doctor's source index.
 * Release stages and API changes come from versioned upgrade knowledge, and
 * library blockers come from enterprise guidance named
 * `upgrade/<package>/<major>/...`. Blockers are listed before any stage.
 * Work compatible with the current version is separated as preparation.
 * Each stage names its rollback boundary and narrowest verification, and
 * behavior no static check establishes is left to review. Web Doctor never
 * edits the manifest, lockfile, or source; every command is for the developer.
 */

export interface Occurrence {
  path: string;
  line: number;
  column: number;
  symbol: string | null;
}

export interface PlannedChange {
  change: string;
  title: string;
  status: UpgradeChange["status"];
  replacement: string;
  detection: "automatic";
  occurrences: Occurrence[];
}

export interface DependencyChange {
  package: string;
  field: string | null;
  from: string | null;
  to: string;
  reason: string;
  evidence: FactView | null;
}

export interface Blocker {
  package: string;
  installed: string | null;
  reason: string;
  alternatives: string[];
  source: string;
  /** The stage that cannot land until this is resolved. */
  stage: string;
  evidence: FactView[];
}

export interface VerificationStep {
  kind: string;
  description: string;
  command: string | null;
  evidence: FactView | null;
}

export interface PlanStage {
  order: number;
  id: string;
  version: string | null;
  purpose: string;
  blockedBy: string[];
  dependencies: DependencyChange[];
  changes: PlannedChange[];
  verification: VerificationStep[];
  review: string[];
  rollback: string;
}

export interface UpgradePlan {
  schema: "web-doctor.upgrade-plan";
  schemaVersion: 1;
  package: string;
  current: { version: string | null; evidence: FactView | null };
  target: string;
  status: "planned" | "not_needed" | "unresolved";
  unresolved: string[];
  environment: { packageManager: FactView | null; runtimes: FactView[] };
  blockers: Blocker[];
  stages: PlanStage[];
  /** Review and runtime validation no static check establishes, across all stages. */
  manual: string[];
  /** Direct dependencies whose compatibility with the target no fact or guidance establishes. */
  unestablished: string[];
  modifiesProject: false;
  provenance: {
    detectorRelease: string | null;
    configurationDigest: string | null;
    factDocumentDigest: string | null;
    extensionStateDigest: string;
    indexDigest: string;
    knowledge: { id: string; version: string; digest: string };
  };
}

export interface UpgradeRequest {
  snapshot: ProjectSnapshot;
  registry: RegistrySnapshot;
  config: RepositoryConfig | null;
  package: string;
  target: string;
}

const COMMAND_ORDER = ["typecheck", "test", "lint", "build"];

export function planUpgrade(request: UpgradeRequest): UpgradePlan {
  const { snapshot } = request;
  const knowledge = UPGRADE_KNOWLEDGE[request.package];
  const shared = snapshot.shared.status === "complete" ? snapshot.shared.document : null;
  const index = snapshot.extensions.index;
  const target = semver.valid(semver.coerce(request.target)) ?? request.target;
  const environment = shared === null ? { packageManager: null, runtimes: [] } : environmentOf(shared);
  const base = {
    schema: "web-doctor.upgrade-plan" as const,
    schemaVersion: 1 as const,
    package: request.package,
    target,
    environment,
    modifiesProject: false as const,
    provenance: {
      detectorRelease: snapshot.shared.provenance?.detectorRelease ?? null,
      configurationDigest: snapshot.shared.provenance?.configurationDigest ?? null,
      factDocumentDigest: snapshot.shared.status === "complete" ? snapshot.shared.documentDigest : null,
      extensionStateDigest: snapshot.extensions.digest,
      indexDigest: index.digest,
      knowledge: knowledge === undefined ? { id: request.package, version: "none", digest: "0".repeat(64) } : { id: knowledge.id, version: knowledge.version, digest: knowledgeDigest(knowledge) },
    },
  };
  const empty = { blockers: [], stages: [], manual: [], unestablished: [] };
  const unresolvedPlan = (reason: string, current: UpgradePlan["current"] = { version: null, evidence: null }): UpgradePlan => ({ ...base, ...empty, current, status: "unresolved", unresolved: [reason] });
  if (knowledge === undefined) return unresolvedPlan(`Web Doctor has no upgrade knowledge for ${request.package}`);
  if (shared === null) return unresolvedPlan(`Shared repository facts are unavailable: ${snapshot.shared.status === "incomplete" ? snapshot.shared.reason : "unknown"}`);
  if (semver.valid(target) === null) return unresolvedPlan(`${request.target} is not a version`);
  const last = knowledge.stages.at(-1)!;
  if (semver.major(target) > semver.major(last.version)) return unresolvedPlan(`Upgrade knowledge ${knowledge.id} ${knowledge.version} covers ${request.package} up to ${semver.major(last.version)}`);

  const current = installed(shared, request.package);
  if (current.version === null) return unresolvedPlan(current.reason, { version: null, evidence: current.evidence });
  const currentVersion = current.version;
  const currentPlan = { version: currentVersion, evidence: current.evidence };
  if (semver.lt(currentVersion, knowledge.from)) return unresolvedPlan(`Upgrade knowledge ${knowledge.id} plans from ${knowledge.from}; ${request.package} ${currentVersion} is older`, currentPlan);
  if (semver.gte(currentVersion, target)) return { ...base, ...empty, current: currentPlan, status: "not_needed", unresolved: [] };

  const relevant = knowledge.stages.filter((stage) => semver.gt(stage.version, currentVersion) && semver.lte(stage.version, target));
  if (relevant.length === 0 || semver.lt(relevant.at(-1)!.version, target)) {
    // A patch or minor after the last known stage adds no API changes of its own.
    relevant.push({ version: target, purpose: `Move to ${request.package} ${target}`, changes: [], review: [] });
  }
  const stageId = (version: string) => `${request.package}-${version}`;
  const preparation: PlannedChange[] = [];
  const placed = new Map<string, PlannedChange[]>(relevant.map((stage) => [stage.version, []]));
  const latest = new Map<string, UpgradeChange>();
  for (const stage of relevant) for (const change of stage.changes) latest.set(change.id, change);
  for (const change of [...latest.values()].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const occurrences = occurrencesOf(index, change);
    if (occurrences.length === 0) continue;
    const planned: PlannedChange = { change: change.id, title: change.title, status: change.status, replacement: change.replacement, detection: "automatic", occurrences };
    if (semver.lte(change.availableFrom, currentVersion)) preparation.push(planned);
    else placed.get((relevant.find((stage) => semver.gte(stage.version, change.availableFrom)) ?? relevant.at(-1)!).version)!.push(planned);
  }

  const manager = environment.packageManager === null ? null : PACKAGE_MANAGER_COMMANDS[String(environment.packageManager.value)] ?? null;
  const commands = verificationCommands(shared);
  const testsFor = (changes: readonly PlannedChange[]): VerificationStep[] => {
    const paths = new Set(changes.flatMap((change) => change.occurrences.map((occurrence) => occurrence.path)));
    const tests = (snapshot.extensions.categories["web-doctor.tests"]?.facts ?? []).filter((fact) => subjectsOf(fact).some((subject) => paths.has(subject)) || paths.has(fact.key));
    return tests.map((fact) => ({ kind: "tests-for-change", description: `Run ${fact.key}, which covers a changed module`, command: null, evidence: factView("extension", snapshot.extensions.document, "web-doctor.tests", fact) }));
  };

  const blockers = [
    ...lockstepMismatches(knowledge, shared, currentVersion),
    ...libraryBlockers(request, shared, relevant.map((stage) => stage.version), stageId),
  ];
  const stages: PlanStage[] = [];
  const blockedBy = (id: string) => [...new Set(blockers.filter((blocker) => blocker.stage === id).map((blocker) => blocker.package))].sort(compareCodeUnits);
  if (preparation.length > 0 || blockedBy("preparation").length > 0) {
    stages.push({
      order: 0,
      id: "preparation",
      version: null,
      purpose: `Changes that work on ${request.package} ${currentVersion} and can land before the upgrade`,
      blockedBy: blockedBy("preparation"),
      dependencies: [],
      changes: preparation,
      verification: [...testsFor(preparation), ...commands],
      review: [],
      rollback: `Each preparation change works on ${request.package} ${currentVersion} and can be reverted on its own`,
    });
  }
  let previous = currentVersion;
  for (const stage of relevant) {
    const changes = placed.get(stage.version)!;
    const dependencies = dependencyChanges(knowledge, shared, currentVersion, stage.version);
    stages.push({
      order: stages.length,
      id: stageId(stage.version),
      version: stage.version,
      purpose: stage.purpose,
      blockedBy: blockedBy(stageId(stage.version)),
      dependencies,
      changes,
      verification: [...installSteps(dependencies, manager), ...testsFor(changes), ...commands],
      review: stage.review,
      rollback: `Land this stage's manifest, lockfile, and source changes as one change; reverting it restores ${request.package} ${previous}`,
    });
    previous = stage.version;
  }

  const lockstep = new Set([request.package, ...knowledge.lockstep.map((entry) => entry.package)]);
  const blocked = new Set(blockers.map((blocker) => blocker.package));
  const unestablished = [...new Set((shared.categories.dependencies?.facts ?? []).map((fact) => String((fact.value as { name?: unknown }).name)))].filter((name) => !lockstep.has(name) && !blocked.has(name)).sort(compareCodeUnits);
  const manual = [
    ...stages.flatMap((stage) => stage.review),
    ...(commands.length === 0 ? ["No typecheck, test, lint, or build command is declared; verify each stage by hand"] : []),
    ...(manager === null ? ["No single package manager is established; run each stage's dependency changes with the repository's package manager"] : []),
    ...(unestablished.length === 0 ? [] : [`Confirm that ${listed(unestablished)} support ${request.package} ${target}; no fact or guidance establishes it`]),
  ];
  return { ...base, current: currentPlan, status: "planned", unresolved: [], blockers, stages, manual, unestablished };
}

/** The installed version: one resolved version, or one exact declared version. */
function installed(shared: FactDocument, name: string): { version: string | null; evidence: FactView | null; reason: string } {
  const resolved = (shared.categories.resolved_dependencies?.facts ?? []).filter((fact) => fact.state === "observed" && (fact.value as { name?: unknown }).name === name);
  const versions = [...new Set(resolved.map((fact) => String((fact.value as { version?: unknown }).version)))];
  if (versions.length === 1 && semver.valid(versions[0]!) !== null) return { version: versions[0]!, evidence: factView("shared", shared, "resolved_dependencies", resolved[0]!), reason: "" };
  if (versions.length > 1) return { version: null, evidence: null, reason: `The lockfile resolves several ${name} versions: ${versions.join(", ")}` };
  const declared = declarations(shared, name);
  const specifiers = [...new Set(declared.map((fact) => String((fact.value as { specifier?: unknown }).specifier)))];
  if (specifiers.length === 1 && semver.valid(specifiers[0]!) !== null) return { version: specifiers[0]!, evidence: factView("shared", shared, "dependencies", declared[0]!), reason: "" };
  if (declared.length === 0) return { version: null, evidence: null, reason: `No fact shows ${name} as a dependency` };
  return { version: null, evidence: factView("shared", shared, "dependencies", declared[0]!), reason: `${name} is declared as ${specifiers.join(", ")} and no lockfile fact resolves the installed version` };
}

function declarations(shared: FactDocument, name: string): DocumentFact[] {
  return (shared.categories.dependencies?.facts ?? []).filter((fact) => (fact.value as { name?: unknown }).name === name);
}

function environmentOf(shared: FactDocument): UpgradePlan["environment"] {
  const manager = packageManagerOf(shared);
  return {
    packageManager: manager === null ? null : factView("shared", shared, "package_managers", manager),
    runtimes: (shared.categories.runtime_requirements?.facts ?? []).map((fact) => factView("shared", shared, "runtime_requirements", fact)),
  };
}

function occurrencesOf(index: ProjectIndex, change: UpgradeChange): Occurrence[] {
  const found: Occurrence[] = [];
  const add = (path: string, location: { line: number; column: number }, symbol: string | null) => found.push({ path, line: location.line, column: location.column, symbol });
  for (const mount of index.runtime.mounts) if (change.detection.mounts?.includes(mount.api as "render" | "hydrate")) add(mount.path, mount.location, mount.enclosing);
  for (const call of index.runtime.apiCalls) {
    if (change.detection.calls?.some((rule) => rule.module === call.module && rule.names.includes(call.name))) add(call.path, call.location, call.enclosing);
  }
  for (const pattern of index.runtime.legacy) if (change.detection.legacy?.includes(pattern.kind)) add(pattern.path, pattern.location, pattern.symbol);
  for (const module of index.modules) {
    for (const imported of module.imports) {
      if (change.detection.imports?.some((rule) => rule.module === imported.specifier && (rule.names === undefined || imported.names.some((name) => rule.names!.includes(name.imported))))) add(module.path, imported.location, imported.enclosing);
    }
  }
  const unique = new Map(found.map((occurrence) => [`${occurrence.path}:${occurrence.line}:${occurrence.column}`, occurrence]));
  return [...unique.values()].sort((left, right) => compareCodeUnits(left.path, right.path) || left.line - right.line || left.column - right.column);
}

function verificationCommands(shared: FactDocument): VerificationStep[] {
  return COMMAND_ORDER.flatMap((kind) => {
    const declared = declaredCommand(shared, kind);
    return declared === null ? [] : [{ kind, description: `Run the declared ${kind} command (${declared.declared})`, command: declared.command, evidence: declared.evidence }];
  });
}

function dependencyChanges(knowledge: UpgradeKnowledge, shared: FactDocument, current: string, to: string): DependencyChange[] {
  const fieldOf = (name: string) => {
    const fields = [...new Set(declarations(shared, name).map((fact) => String((fact.value as { field?: unknown }).field)))];
    return fields.length === 1 ? fields[0]! : null;
  };
  const changes: DependencyChange[] = [{ package: knowledge.package, field: fieldOf(knowledge.package), from: current, to, reason: "The package being upgraded", evidence: installed(shared, knowledge.package).evidence }];
  for (const entry of knowledge.lockstep) {
    if (declarations(shared, entry.package).length === 0) continue;
    const present = installed(shared, entry.package);
    const next = entry.rule === "same-version" ? to : `^${semver.major(to)}`;
    if (entry.rule === "same-major" && present.version !== null && semver.major(present.version) === semver.major(to)) continue;
    changes.push({
      package: entry.package,
      field: fieldOf(entry.package),
      from: present.version,
      to: next,
      reason: entry.rule === "same-version" ? `${entry.package} must match ${knowledge.package} exactly` : `${entry.package} must match the ${knowledge.package} major version`,
      evidence: present.evidence ?? factView("shared", shared, "dependencies", declarations(shared, entry.package)[0]!),
    });
  }
  return changes;
}

function installSteps(dependencies: readonly DependencyChange[], manager: { add: string; dev: string } | null): VerificationStep[] {
  const groups = [
    { dev: false, items: dependencies.filter((change) => change.field !== "devDependencies") },
    { dev: true, items: dependencies.filter((change) => change.field === "devDependencies") },
  ].filter((group) => group.items.length > 0);
  return groups.map((group) => ({
    kind: "install",
    description: `Update ${group.items.map((change) => change.package).join(", ")} together and confirm the lockfile resolves one version of each`,
    command: manager === null ? null : `${group.dev ? manager.dev : manager.add} ${group.items.map((change) => `${change.package}@${change.to}`).join(" ")}`,
    evidence: group.items[0]!.evidence,
  }));
}

function lockstepMismatches(knowledge: UpgradeKnowledge, shared: FactDocument, current: string): Blocker[] {
  return knowledge.lockstep.filter((entry) => entry.rule === "same-version").flatMap((entry) => {
    const present = installed(shared, entry.package);
    if (present.version === null || present.version === current) return [];
    return [{ package: entry.package, installed: present.version, reason: `${entry.package} ${present.version} does not match ${knowledge.package} ${current}; align them before upgrading`, alternatives: [], source: `${knowledge.id} upgrade knowledge ${knowledge.version}`, stage: "preparation", evidence: present.evidence === null ? [] : [present.evidence] }];
  });
}

/** Enterprise guidance `upgrade/<package>/<major>/...` whose dependency applicability matches the installed versions. */
function libraryBlockers(request: UpgradeRequest, shared: FactDocument, versions: readonly string[], stageId: (version: string) => string): Blocker[] {
  const facts = policyFactsFor(request.snapshot, request.registry, request.config).facts;
  const prefix = `upgrade/${request.package}/`;
  const blockers: Blocker[] = [];
  for (const entry of [...request.registry.guidance].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    if (!entry.id.startsWith(prefix)) continue;
    const major = Number(entry.id.slice(prefix.length).split("/")[0]);
    const stage = versions.find((version) => semver.major(version) === major);
    if (stage === undefined || evaluateApplicability(entry.applicability, facts).status !== "match") continue;
    for (const dependency of entry.applicability.dependencies ?? []) {
      const present = installed(shared, dependency.name);
      blockers.push({
        package: dependency.name,
        installed: present.version,
        reason: entry.explanation,
        alternatives: entry.alternatives,
        source: `${entry.id}@${entry.version}`,
        stage: stageId(stage),
        evidence: [
          ...declarations(shared, dependency.name).map((fact) => factView("shared", shared, "dependencies", fact)),
          ...(present.evidence?.category === "resolved_dependencies" ? [present.evidence] : []),
        ],
      });
    }
  }
  return blockers;
}

function subjectsOf(fact: DocumentFact): string[] {
  const subjects = (fact.value as { subjects?: unknown }).subjects;
  return Array.isArray(subjects) ? subjects.filter((subject): subject is string => typeof subject === "string") : [];
}

function listed(names: readonly string[]): string {
  const shown = names.slice(0, 20).join(", ");
  return names.length > 20 ? `${shown}, and ${names.length - 20} more` : shown;
}
