import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Runs inside a bounded provider worker. Loads catalog-approved plugins only
 * after re-verifying their digests, runs only the rules effective policy
 * requested, and never applies fixes. Application configuration is loaded
 * exactly as found; if it cannot be composed, the task reports why instead of
 * falling back to another configuration.
 */

export type EslintConfigMode = { mode: "flat"; file: string } | { mode: "legacy"; file: string } | { mode: "none" };

export interface EslintTaskInput {
  root: string;
  config: EslintConfigMode;
  /** Application-relative files to lint. */
  files: string[];
  plugins: { namespace: string; path: string; digest: string }[];
  /** Rule id to severity: 2 for required Controls, 1 otherwise. */
  rules: Record<string, 1 | 2>;
}

export interface EslintTaskMessage {
  ruleId: string;
  severity: 1 | 2;
  message: string;
  messageId: string | null;
  line: number;
  column: number;
  endLine: number | null;
  endColumn: number | null;
  fix: boolean;
  suggestions: string[];
  anchor: string | null;
  /** Set when an inline directive disabled the rule here; recorded, not honored as a waiver. */
  suppression: { justification: string | null } | null;
}

export interface EslintTaskOutput {
  engineVersion: string;
  config: EslintConfigMode["mode"];
  files: number;
  results: { path: string; messages: EslintTaskMessage[] }[];
  /** Files the configuration could not parse or did not match. */
  unanalyzed: { path: string; reason: string }[];
  unavailableRules: Record<string, string>;
  ruleTypes: Record<string, string | null>;
  configError: string | null;
}

interface RuleDefinition {
  meta?: { type?: string };
}

interface Plugin {
  rules?: Record<string, RuleDefinition>;
}

interface LintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  messageId?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  fatal?: boolean;
  fix?: unknown;
  suggestions?: { desc: string }[];
}

interface LintResult {
  filePath: string;
  messages: LintMessage[];
  suppressedMessages?: (LintMessage & { suppressions?: { kind: string; justification?: string }[] })[];
}

interface LinterInstance {
  lintFiles(patterns: string[]): Promise<LintResult[]>;
}

type LinterConstructor = new (options: Record<string, unknown>) => LinterInstance;

export async function lint(input: EslintTaskInput, environment: { scratch: string | null } = { scratch: null }): Promise<EslintTaskOutput> {
  const eslint = await import("eslint") as unknown as { ESLint: LinterConstructor & { version: string }; loadESLint(options: { useFlatConfig: boolean }): Promise<LinterConstructor> };
  const { builtinRules } = await import("eslint/use-at-your-own-risk") as unknown as { builtinRules: Map<string, RuleDefinition> };
  const plugins: Record<string, Plugin> = {};
  for (const plugin of input.plugins) {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(plugin.path)).digest("hex");
    if (digest !== plugin.digest) throw new Error(`Plugin ${plugin.namespace} does not match its approved digest`);
    const loaded = await import(pathToFileURL(plugin.path).href) as { default?: Plugin } & Plugin;
    plugins[plugin.namespace] = loaded.default ?? loaded;
  }

  const unavailableRules: Record<string, string> = {};
  const ruleTypes: Record<string, string | null> = {};
  const rules: Record<string, 1 | 2> = {};
  for (const [ruleId, severity] of Object.entries(input.rules)) {
    const slash = ruleId.indexOf("/");
    const namespace = slash === -1 ? null : ruleId.slice(0, slash);
    const definition = namespace === null ? builtinRules.get(ruleId) : plugins[namespace]?.rules?.[ruleId.slice(slash + 1)];
    if (definition === undefined) {
      unavailableRules[ruleId] = namespace === null ? `ESLint has no core rule ${ruleId}` : plugins[namespace] === undefined ? `Plugin ${namespace} is not catalog-approved` : `Plugin ${namespace} does not define ${ruleId.slice(slash + 1)}`;
      continue;
    }
    rules[ruleId] = severity;
    ruleTypes[ruleId] = definition.meta?.type ?? null;
  }

  const output: EslintTaskOutput = { engineVersion: eslint.ESLint.version, config: input.config.mode, files: input.files.length, results: [], unanalyzed: [], unavailableRules, ruleTypes, configError: null };
  if (Object.keys(rules).length === 0 || input.files.length === 0) return output;
  const absolute = input.files.map((file) => path.join(input.root, ...file.split("/")));
  let results: LintResult[];
  try {
    if (input.config.mode === "legacy") {
      const LegacyESLint = await eslint.loadESLint({ useFlatConfig: false });
      const linter = new LegacyESLint({
        cwd: input.root,
        useEslintrc: false,
        overrideConfigFile: input.config.file,
        plugins,
        overrideConfig: { plugins: Object.keys(plugins), rules },
        cache: false,
        // Legacy ESLint deletes its cache file when caching is off; keep that inside the scratch directory.
        ...(environment.scratch === null ? {} : { cacheLocation: path.join(environment.scratch, "eslintcache") }),
        fix: false,
        errorOnUnmatchedPattern: false,
      });
      results = await linter.lintFiles(absolute);
    } else {
      const linter = new eslint.ESLint({
        cwd: input.root,
        overrideConfigFile: input.config.mode === "flat" ? input.config.file : true,
        ...(input.config.mode === "none" ? { baseConfig: await baseConfig() } : {}),
        overrideConfig: [{ plugins, rules }],
        ruleFilter: ({ ruleId }: { ruleId: string }) => Object.hasOwn(rules, ruleId),
        cache: false,
        fix: false,
        errorOnUnmatchedPattern: false,
        warnIgnored: true,
      });
      results = await linter.lintFiles(absolute);
    }
  } catch (error) {
    // Access denials are not configuration problems; the worker reports them as denied capabilities.
    if ((error as { code?: unknown }).code === "ERR_ACCESS_DENIED" || (error as { code?: unknown }).code === "ERR_WEB_DOCTOR_NETWORK_DENIED") throw error;
    output.configError = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 500);
    return output;
  }

  for (const result of results) {
    const relative = path.relative(input.root, result.filePath).split(path.sep).join("/");
    const fatal = result.messages.find((message) => message.fatal === true || message.ruleId === null);
    if (fatal !== undefined) {
      output.unanalyzed.push({ path: relative, reason: fatal.message.split("\n")[0]!.slice(0, 300) });
      continue;
    }
    let lines: string[] | undefined;
    const suppressed = (result.suppressedMessages ?? []).map((message) => ({ ...message, suppressedBy: message.suppressions?.[0]?.justification?.trim() || null }));
    const messages = [...result.messages.map((message) => ({ ...message, suppressedBy: undefined as string | null | undefined })), ...suppressed]
      .filter((message): message is typeof message & { ruleId: string } => message.ruleId !== null && Object.hasOwn(rules, message.ruleId))
      .map((message): EslintTaskMessage => {
        lines ??= fs.readFileSync(result.filePath, "utf8").split("\n");
        const line = message.line ?? 1;
        return {
          ruleId: message.ruleId,
          severity: message.severity >= 2 ? 2 : 1,
          message: message.message,
          messageId: message.messageId ?? null,
          line,
          column: message.column ?? 1,
          endLine: message.endLine ?? null,
          endColumn: message.endColumn ?? null,
          fix: message.fix !== undefined,
          suggestions: (message.suggestions ?? []).map((suggestion) => suggestion.desc).slice(0, 5),
          anchor: lines[line - 1]?.trim().slice(0, 200) ?? null,
          suppression: message.suppressedBy === undefined ? null : { justification: message.suppressedBy },
        };
      });
    if (messages.length > 0) output.results.push({ path: relative, messages });
  }
  output.results.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  output.unanalyzed.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return output;
}

/** Parses JavaScript, JSX, and TypeScript when the application declares no ESLint configuration. */
async function baseConfig(): Promise<unknown[]> {
  const parser = await import("@typescript-eslint/parser") as { default?: unknown };
  return [
    { files: ["**/*.js", "**/*.jsx", "**/*.mjs"], languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } } },
    { files: ["**/*.cjs"], languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" } },
    { files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"], languageOptions: { parser: parser.default ?? parser, ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } } },
  ];
}
