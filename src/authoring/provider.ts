import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";
import semver from "semver";
import * as z from "zod/v4";
import {
  contributionSchema,
  identifierSchema,
  nonEmptyStringSchema,
  packagePathSchema,
  providerManifestSchema,
  versionedDocumentFields,
  type Contribution,
  type ProviderManifest,
} from "../contracts/index.js";
import { WEB_DOCTOR_VERSION } from "../version.js";

const providerFixtureSchema = z.strictObject({
  ...versionedDocumentFields("web-doctor.provider-fixture", 1),
  id: identifierSchema,
  rule: identifierSchema,
  input: packagePathSchema,
  filename: nonEmptyStringSchema,
  expected: z.enum(["pass", "fail"]),
});

export interface ProviderValidationIssue {
  code: "schema" | "namespace" | "dependency" | "capability" | "compatibility" | "rule_catalog" | "fixture" | "nondeterministic";
  path: string;
  message: string;
}

export interface ProviderValidationOptions {
  manifestPath: string;
  contributionPath: string;
  pluginPath: string;
  fixturePaths: readonly string[];
}

export interface ProviderValidationReport {
  valid: boolean;
  issues: ProviderValidationIssue[];
  fixtures: number;
  rules: number;
}

interface EslintPlugin {
  rules?: Record<string, unknown>;
}

export async function validateProviderAuthoring(options: ProviderValidationOptions): Promise<ProviderValidationReport> {
  const issues: ProviderValidationIssue[] = [];
  const manifestResult = providerManifestSchema.safeParse(await readJson(options.manifestPath));
  const contributionResult = contributionSchema.safeParse(await readJson(options.contributionPath));
  if (!manifestResult.success) addZodIssues(manifestResult.error.issues, "manifest", "schema", issues);
  if (!contributionResult.success) addZodIssues(contributionResult.error.issues, "contribution", "dependency", issues);
  const manifest = manifestResult.success ? manifestResult.data : undefined;
  const contribution = contributionResult.success ? contributionResult.data : undefined;
  if (manifest !== undefined) validateManifest(manifest, issues);
  if (manifest !== undefined && contribution !== undefined) validateContribution(manifest, contribution, issues);

  let plugin: EslintPlugin | undefined;
  try {
    const imported = await import(`${pathToFileURL(path.resolve(options.pluginPath)).href}?validate=${Date.now()}`) as { default?: EslintPlugin } & EslintPlugin;
    plugin = imported.default ?? imported;
  } catch (error) {
    add(issues, "schema", "plugin", `Cannot load ESLint plugin: ${messageFrom(error)}`);
  }
  if (manifest !== undefined && plugin !== undefined) validateRuleCatalog(manifest, plugin, issues);

  for (const fixturePath of options.fixturePaths) {
    const result = providerFixtureSchema.safeParse(await readJson(fixturePath));
    if (!result.success) {
      addZodIssues(result.error.issues, `fixtures.${fixturePath}`, "fixture", issues);
      continue;
    }
    if (manifest === undefined || plugin === undefined) continue;
    await validateFixture(result.data, fixturePath, manifest, plugin, issues);
  }

  issues.sort((left, right) => `${left.code}\0${left.path}\0${left.message}`.localeCompare(`${right.code}\0${right.path}\0${right.message}`));
  return {
    valid: issues.length === 0,
    issues,
    fixtures: options.fixturePaths.length,
    rules: manifest?.rules.length ?? 0,
  };
}

function validateManifest(manifest: ProviderManifest, issues: ProviderValidationIssue[]): void {
  const webDoctorRange = semver.validRange(manifest.compatibility.webDoctor);
  if (webDoctorRange === null) add(issues, "compatibility", "manifest.compatibility.webDoctor", "Invalid Web Doctor compatibility range");
  else if (!semver.satisfies(WEB_DOCTOR_VERSION, webDoctorRange)) {
    add(issues, "compatibility", "manifest.compatibility.webDoctor", `Web Doctor ${WEB_DOCTOR_VERSION} is outside ${manifest.compatibility.webDoctor}`);
  }
  const engineRange = semver.validRange(manifest.engineRange);
  if (engineRange === null) add(issues, "compatibility", "manifest.engineRange", "Invalid ESLint engine range");
  else if (manifest.engine !== "eslint") add(issues, "compatibility", "manifest.engine", "Provider validation supports the ESLint engine contract");
  else if (!semver.satisfies(Linter.version, engineRange)) {
    add(issues, "compatibility", "manifest.engineRange", `ESLint ${Linter.version} is outside ${manifest.engineRange}`);
  }
  if (manifest.capabilities.includes("network-registry") || manifest.capabilities.includes("network-target")) {
    add(issues, "capability", "manifest.capabilities", "ESLint authoring fixtures cannot request network capabilities");
  }
}

function validateContribution(manifest: ProviderManifest, contribution: Contribution, issues: ProviderValidationIssue[]): void {
  if (contribution.type !== "provider" && contribution.type !== "adapter") {
    add(issues, "dependency", "contribution.type", "ESLint provider validation requires a provider or adapter contribution");
  }
  if (contribution.owner !== manifest.owner) add(issues, "namespace", "contribution.owner", "Contribution and provider owners must match");
  if (contribution.compatibility.webDoctor !== manifest.compatibility.webDoctor) {
    add(issues, "compatibility", "contribution.compatibility.webDoctor", "Contribution and provider compatibility ranges must match");
  }
}

function validateRuleCatalog(manifest: ProviderManifest, plugin: EslintPlugin, issues: ProviderValidationIssue[]): void {
  const declared = new Set(manifest.rules.map((rule) => rule.id));
  const implemented = new Set(Object.keys(plugin.rules ?? {}));
  for (const rule of [...declared].sort()) {
    if (!implemented.has(rule)) add(issues, "rule_catalog", `manifest.rules.${rule}`, `Declared rule ${rule} is absent from the plugin`);
  }
  for (const rule of [...implemented].sort()) {
    if (!declared.has(rule)) add(issues, "rule_catalog", `plugin.rules.${rule}`, `Plugin rule ${rule} is not declared in the manifest`);
  }
}

async function validateFixture(
  fixture: z.infer<typeof providerFixtureSchema>,
  fixturePath: string,
  manifest: ProviderManifest,
  plugin: EslintPlugin,
  issues: ProviderValidationIssue[],
): Promise<void> {
  const root = `fixtures.${fixture.id}`;
  if (!manifest.rules.some((rule) => rule.id === fixture.rule)) {
    add(issues, "fixture", `${root}.rule`, `Fixture references undeclared rule ${fixture.rule}`);
    return;
  }
  if (plugin.rules?.[fixture.rule] === undefined) {
    add(issues, "fixture", `${root}.rule`, `Fixture references unimplemented rule ${fixture.rule}`);
    return;
  }
  const source = await fs.readFile(path.resolve(path.dirname(fixturePath), fixture.input), "utf8");
  const first = runRule(manifest.id, fixture.rule, plugin, source, fixture.filename);
  const second = runRule(manifest.id, fixture.rule, plugin, source, fixture.filename);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    add(issues, "nondeterministic", root, "Fixture produced different normalized diagnostics across identical runs");
    return;
  }
  const passed = first.length === 0;
  if ((fixture.expected === "pass") !== passed) {
    add(issues, "fixture", root, `Fixture expected ${fixture.expected} but produced ${first.length} diagnostics`);
  }
}

function runRule(namespace: string, rule: string, plugin: EslintPlugin, source: string, filename: string) {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(source, [{
    files: ["**/*"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { [namespace]: plugin as never },
    rules: { [`${namespace}/${rule}`]: "error" },
  }], { filename }).map((message) => ({
    ruleId: message.ruleId,
    message: message.message,
    line: message.line,
    column: message.column,
    endLine: message.endLine,
    endColumn: message.endColumn,
  }));
}

function addZodIssues(
  zodIssues: readonly { path: PropertyKey[]; message: string }[],
  root: string,
  code: ProviderValidationIssue["code"],
  issues: ProviderValidationIssue[],
): void {
  for (const issue of zodIssues) add(issues, code, [root, ...issue.path.map(String)].join("."), issue.message);
}

function add(issues: ProviderValidationIssue[], code: ProviderValidationIssue["code"], issuePath: string, message: string): void {
  issues.push({ code, path: issuePath, message });
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}