import path from "node:path";
import {
  type BlobContent,
  type Detector,
  type DetectorContext,
  type DocumentFact,
  type Evidence,
  type FactDocument,
  compareCodeUnits,
} from "@repo-facts/contract";
import ts from "typescript";
import { type IndexLocation, type IndexedUse, type ProjectIndex, SOURCE_EXTENSIONS } from "./project-index.js";
import { search } from "./react-detectors.js";

/**
 * Extensions for entry points, tests, routes, and framework source
 * relationships. Each activates only on matching evidence: build-tool entries
 * need the shared document to report that build tool; tests need a declared
 * or imported test framework; federation, frame, and message relationships
 * need the matching shared composition or runtime-integration fact. Values
 * that are computed or unsupported are reported as unresolved, never guessed.
 */

/** The only shared categories Web Doctor's extensions read, with the evidence paths they consult. */
export const SHARED_EXTENSION_INPUTS: readonly string[] = ["build_tools", "composition", "frameworks", "runtime_integrations", "test_frameworks", "verification_commands"];

export const ENTRY_POINTS = "web-doctor.entry_points";
export const TESTS = "web-doctor.tests";
export const ROUTES = "web-doctor.routes";
export const RELATIONSHIPS = "web-doctor.source_relationships";

const SOURCE_INPUTS = SOURCE_EXTENSIONS.map((extension) => `**/*${extension}`);
const CONFIG_NAMES: Readonly<Record<string, readonly string[]>> = {
  webpack: ["webpack.config.js", "webpack.config.cjs", "webpack.config.mjs", "webpack.config.ts"],
  rspack: ["rspack.config.js", "rspack.config.cjs", "rspack.config.mjs", "rspack.config.ts"],
  vite: ["vite.config.js", "vite.config.cjs", "vite.config.mjs", "vite.config.ts", "vite.config.mts"],
};
const TEST_PACKAGES = ["vitest", "@jest/globals", "jest", "@playwright/test", "mocha", "chai", "cypress", "node:test", "@testing-library/react", "@testing-library/dom", "@testing-library/user-event"];
const TEST_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;

type EntryResolution = "literal" | "idiom" | "default" | "computed";

interface ResolvedPath {
  module: string | null;
  resolution: EntryResolution;
  expression: string | null;
  /** The lines of the source content that state the value. */
  lines: { start: number; end: number };
}

interface ConfigEntry {
  name: string;
  resolved: ResolvedPath;
  reasoning: string;
  content: BlobContent;
}

export function sourceDetectors(index: ProjectIndex, shared: FactDocument | undefined): Detector[] {
  return [entryPointDetector(index, shared), testDetector(index, shared), routeDetector(index, shared), relationshipDetector(index, shared)];
}

function entryPointDetector(index: ProjectIndex, shared: FactDocument | undefined): Detector {
  return {
    id: "web-doctor.entry-points",
    version: "1",
    stage: "architecture",
    inputs: [...Object.values(CONFIG_NAMES).flat().map((name) => `**/${name}`), "**/index.html", ...SOURCE_INPUTS],
    categories: [ENTRY_POINTS],
    async run(context) {
      const surface = new Set<string>();
      const skipped = new Set<string>();
      const tools = new Set(established(shared, "build_tools").map((fact) => fact.key));
      const buildCommands = established(shared, "verification_commands").filter((fact) => kindsOf(fact).includes("build"));
      for (const tool of ["webpack", "rspack", "vite"].filter((candidate) => tools.has(candidate))) {
        for (const entry of CONFIG_NAMES[tool]!.flatMap((name) => context.entries(`**/${name}`))) {
          surface.add(entry.path);
          const content = await context.text(entry.path);
          const parsed = content === null ? null : parseConfig(content);
          if (content === null || parsed === null) {
            skipped.add(entry.path);
            continue;
          }
          const commands = buildCommands.filter((fact) => String((fact.value as { command?: unknown }).command ?? "").includes(tool)).map((fact) => fact.key);
          for (const found of await configEntries(tool, entry.path, content, parsed, index, context)) {
            const value = { kind: "build-entry", source: tool, config: entry.path, name: found.name, module: found.resolved.module, resolution: found.resolved.resolution, expression: found.resolved.expression, commands };
            const evidence = context.lines(found.content, "web-doctor.build-entry", found.resolved.lines.start, found.resolved.lines.end);
            if (found.resolved.resolution === "idiom" || found.resolved.resolution === "default") {
              context.fact({ category: ENTRY_POINTS, key: `build:${entry.path}#${found.name}`, value, basis: "inferred", evidence: [evidence], rule: "web-doctor.build-entry", reasoning: found.reasoning });
            } else {
              context.fact({ category: ENTRY_POINTS, key: `build:${entry.path}#${found.name}`, value, basis: "observed", evidence: [evidence], rule: "web-doctor.build-entry" });
            }
          }
        }
      }
      for (const mount of index.runtime.mounts) {
        const evidence = await lineEvidence(context, "web-doctor.react-root", mount.location);
        if (evidence === null) continue;
        context.fact({
          category: ENTRY_POINTS,
          key: `mount:${mount.path}:${mount.location.line}`,
          value: { kind: "react-root", module: mount.path, api: mount.api, package: mount.module, component: useValue(mount.component), container: mount.container, enclosing: mount.enclosing },
          basis: "observed",
          evidence: [evidence],
          rule: "web-doctor.react-root",
        });
      }
      for (const lifecycles of index.runtime.lifecycles) {
        const evidence = await lineEvidence(context, "web-doctor.single-spa-lifecycles", lifecycles.location);
        if (evidence === null) continue;
        context.fact({
          category: ENTRY_POINTS,
          key: `single-spa:${lifecycles.path}`,
          value: { kind: "single-spa-lifecycles", module: lifecycles.path, package: lifecycles.module, root_component: useValue(lifecycles.rootComponent), lifecycles: lifecycles.lifecycles },
          basis: "observed",
          evidence: [evidence],
          rule: "web-doctor.single-spa-lifecycles",
        });
      }
      for (const federation of established(shared, "composition").filter((fact) => mechanismOf(fact) === "module-federation")) {
        const exposes = (federation.value as { exposes?: unknown }).exposes;
        if (!Array.isArray(exposes) || exposes.length === 0) continue;
        const configPath = evidencePath(shared!, federation);
        if (configPath === null) continue;
        surface.add(configPath);
        const content = await context.text(configPath);
        const parsed = content === null ? null : parseConfig(content);
        if (content === null || parsed === null) {
          skipped.add(configPath);
          continue;
        }
        const mapping = exposesOf(parsed);
        for (const key of exposes.filter((entry): entry is string => typeof entry === "string").sort(compareCodeUnits)) {
          const resolved = mapping.get(key);
          if (resolved === undefined) continue;
          const components = index.symbols.filter((symbol) => symbol.path === resolved.module && symbol.exported && symbol.kind === "component").map((symbol) => symbol.id);
          context.fact({
            category: ENTRY_POINTS,
            key: `federation-expose:${federationName(federation)}#${key}`,
            value: { kind: "federated-expose", federation: federationName(federation), expose: key, config: configPath, module: resolved.module, resolution: resolved.resolution, expression: resolved.expression, components, shared_fact: federation.key },
            basis: "observed",
            evidence: [context.lines(content, "web-doctor.federated-expose", resolved.lines.start, resolved.lines.end)],
            rule: "web-doctor.federated-expose",
          });
        }
      }
      for (const path of index.modules.map((module) => module.path)) surface.add(path);
      context.search({ category: ENTRY_POINTS, rule: "web-doctor.entry-points", surface: [...surface].sort(compareCodeUnits), complete: index.complete && skipped.size === 0, skipped: [...skipped].sort(compareCodeUnits) });
    },
  };
}

function testDetector(index: ProjectIndex, shared: FactDocument | undefined): Detector {
  return {
    id: "web-doctor.tests",
    version: "1",
    stage: "architecture",
    inputs: SOURCE_INPUTS,
    categories: [TESTS],
    async run(context) {
      const frameworks = established(shared, "test_frameworks").map((fact) => fact.key).sort(compareCodeUnits);
      const commands = established(shared, "verification_commands").filter((fact) => kindsOf(fact).includes("test")).map((fact) => fact.key).sort(compareCodeUnits);
      for (const module of index.modules.filter((candidate) => TEST_FILE.test(candidate.path))) {
        const imported = module.imports.find((entry) => entry.target.kind === "package" && TEST_PACKAGES.includes(entry.target.name));
        const importedFramework = imported !== undefined && imported.target.kind === "package" ? imported.target.name : null;
        if (frameworks.length === 0 && importedFramework === null) continue;
        const entry = context.entries(module.path)[0];
        if (entry === undefined) continue;
        const subjects = [...new Set(module.imports.flatMap((candidate) => (candidate.target.kind === "module" && !TEST_FILE.test(candidate.target.path) ? [candidate.target.path] : [])))].sort(compareCodeUnits);
        const symbols = [...new Set(index.references.filter((reference) => reference.path === module.path && !reference.symbol.startsWith(`${module.path}#`)).map((reference) => reference.symbol))].sort(compareCodeUnits);
        const convention = /__tests__\//.test(module.path) ? "a __tests__ directory" : /\.spec\./.test(module.path) ? "the .spec suffix" : "the .test suffix";
        const signal = importedFramework !== null ? `it imports ${importedFramework}` : `the repository declares ${frameworks.join(", ")}`;
        context.fact({
          category: TESTS,
          key: module.path,
          value: { path: module.path, frameworks, imports_framework: importedFramework, subjects, symbols, commands },
          basis: "inferred",
          reasoning: `The file uses ${convention} that test runners collect, and ${signal}`,
          evidence: [context.entry(entry, "web-doctor.test-file")],
          rule: "web-doctor.test-file",
        });
      }
      search(context, index, TESTS, "web-doctor.test-file");
    },
  };
}

function routeDetector(index: ProjectIndex, shared: FactDocument | undefined): Detector {
  return {
    id: "web-doctor.routes",
    version: "1",
    stage: "architecture",
    inputs: SOURCE_INPUTS,
    categories: [ROUTES],
    async run(context) {
      for (const route of index.runtime.routes) {
        const evidence = await lineEvidence(context, "web-doctor.router-route", route.location);
        if (evidence === null) continue;
        context.fact({
          category: ROUTES,
          key: `${route.path}:${route.location.line}:${route.location.column}`,
          value: { router: route.router, style: route.style, path: route.routePath, index: route.index, element: useValue(route.element), parent: route.parent, module: route.path },
          basis: "observed",
          evidence: [evidence],
          rule: "web-doctor.router-route",
        });
      }
      if (established(shared, "frameworks").some((fact) => (fact.value as { id?: unknown }).id === "next")) {
        for (const module of index.modules) {
          const route = nextRoute(module.path);
          const entry = route === null ? undefined : context.entries(module.path)[0];
          if (route === null || entry === undefined) continue;
          context.fact({
            category: ROUTES,
            key: `next:${module.path}`,
            value: { router: "next", style: "file", path: { kind: "literal", value: route.path }, index: false, element: null, parent: null, module: module.path },
            basis: "inferred",
            reasoning: route.reasoning,
            evidence: [context.entry(entry, "web-doctor.next-file-route")],
            rule: "web-doctor.next-file-route",
          });
        }
      }
      search(context, index, ROUTES, "web-doctor.routes");
    },
  };
}

function relationshipDetector(index: ProjectIndex, shared: FactDocument | undefined): Detector {
  return {
    id: "web-doctor.source-relationships",
    version: "1",
    stage: "architecture",
    inputs: SOURCE_INPUTS,
    categories: [RELATIONSHIPS],
    async run(context) {
      const compositions = established(shared, "composition");
      const remotes = compositions
        .filter((fact) => mechanismOf(fact) === "module-federation")
        .flatMap((fact) => {
          const value = fact.value as { remotes?: unknown };
          return Array.isArray(value.remotes) ? value.remotes.flatMap((remote) => {
            if (typeof remote !== "object" || remote === null || typeof (remote as { alias?: unknown }).alias !== "string") return [];
            const federation = (remote as { federation_name?: unknown }).federation_name;
            return [{ alias: (remote as { alias: string }).alias, federation: typeof federation === "string" ? federation : null, fact: fact.key }];
          }) : [];
        });
      for (const module of index.modules) {
        for (const imported of module.imports) {
          const remote = imported.specifier === null ? undefined : remotes.find((candidate) => imported.specifier === candidate.alias || imported.specifier!.startsWith(`${candidate.alias}/`));
          if (remote === undefined) continue;
          const evidence = await lineEvidence(context, "web-doctor.federated-remote-use", imported.location);
          if (evidence === null) continue;
          context.fact({
            category: RELATIONSHIPS,
            key: `federated-remote:${module.path}:${imported.location.line}`,
            value: { kind: "federated-remote-use", remote: remote.alias, federation: remote.federation, exposed: imported.specifier === remote.alias ? "." : `./${imported.specifier!.slice(remote.alias.length + 1)}`, importer: module.path, import_kind: imported.kind, used_by: imported.enclosing, shared_fact: remote.fact },
            basis: "observed",
            evidence: [evidence],
            rule: "web-doctor.federated-remote-use",
          });
        }
      }
      const frames = evidenced(shared, "composition").filter((fact) => agreed(fact, "mechanism") === "iframe");
      if (frames.length > 0) {
        for (const frame of index.runtime.frames) {
          const evidence = await lineEvidence(context, "web-doctor.iframe-host", frame.location);
          if (evidence === null) continue;
          const source = frame.src;
          const match = source?.kind === "literal" ? frames.find((fact) => literalOf(agreed(fact, "src")) === source.value)?.key ?? null : null;
          context.fact({
            category: RELATIONSHIPS,
            key: `iframe:${frame.path}:${frame.location.line}`,
            value: { kind: "iframe-host", component: frame.enclosing, src: frame.src, shared_fact: match },
            basis: "observed",
            evidence: [evidence],
            rule: "web-doctor.iframe-host",
          });
        }
      }
      // A shared fact that conflicts only on the message shape still establishes the contract and direction.
      const integrations = evidenced(shared, "runtime_integrations").filter((fact) => agreed(fact, "contract") === "postMessage");
      for (const message of index.runtime.messages) {
        const integration = integrations.find((fact) => agreed(fact, "direction") === message.direction);
        if (integration === undefined) continue;
        const evidence = await lineEvidence(context, "web-doctor.message-channel", message.location);
        if (evidence === null) continue;
        context.fact({
          category: RELATIONSHIPS,
          key: `message:${message.direction}:${message.path}:${message.location.line}`,
          value: { kind: "message-channel", contract: "postMessage", direction: message.direction, symbol: message.enclosing, module: message.path, shared_fact: integration.key, shared_state: integration.state },
          basis: "observed",
          evidence: [evidence],
          rule: "web-doctor.message-channel",
        });
      }
      search(context, index, RELATIONSHIPS, "web-doctor.source-relationships");
    },
  };
}

/** Facts the shared document established (observed or inferred), never unknown or conflicting ones. */
export function established(shared: FactDocument | undefined, category: string): DocumentFact[] {
  return (shared?.categories[category]?.facts ?? []).filter((fact) => fact.state === "observed" || fact.state === "inferred");
}

/** Facts with evidence, including conflicting ones whose candidates disagree on some attribute. */
function evidenced(shared: FactDocument | undefined, category: string): DocumentFact[] {
  return (shared?.categories[category]?.facts ?? []).filter((fact) => fact.state !== "unknown");
}

/** An attribute of the fact's value, or of every candidate's value when they all agree on it. */
function agreed(fact: DocumentFact, field: string): unknown {
  const read = (value: unknown) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : undefined);
  if (fact.state !== "conflicting") return read(fact.value);
  const values = new Set((fact.candidates ?? []).map((candidate) => JSON.stringify(read(candidate.value) ?? null)));
  return values.size === 1 ? read(fact.candidates![0]!.value) : undefined;
}

function kindsOf(fact: DocumentFact): string[] {
  const kinds = (fact.value as { kinds?: unknown }).kinds;
  return Array.isArray(kinds) ? kinds.filter((kind): kind is string => typeof kind === "string") : [];
}

function mechanismOf(fact: DocumentFact): unknown {
  return (fact.value as { mechanism?: unknown }).mechanism;
}

function federationName(fact: DocumentFact): string {
  return literalOf((fact.value as { name?: unknown }).name) ?? fact.key;
}

function literalOf(value: unknown): string | null {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "literal" && typeof (value as { value?: unknown }).value === "string" ? (value as { value: string }).value : null;
}

function evidencePath(shared: FactDocument, fact: DocumentFact): string | null {
  const id = fact.evidence[0];
  return id === undefined ? null : shared.evidence[id]?.path ?? null;
}

function useValue(use: IndexedUse | null) {
  return use === null ? null : { name: use.name, symbol: use.symbol, module: use.module };
}

async function lineEvidence(context: DetectorContext, rule: string, location: IndexLocation): Promise<Evidence | null> {
  const content = await context.text(location.path);
  return content === null ? null : context.lines(content, rule, location.line, location.endLine);
}

function linesOf(node: ts.Node): { start: number; end: number } {
  const sourceFile = node.getSourceFile();
  return {
    start: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    end: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  };
}

interface ParsedConfig {
  sourceFile: ts.SourceFile;
  directory: string;
  /** The exported configuration object, or the expression that computes it. */
  config: ts.ObjectLiteralExpression | ts.Expression | null;
}

/** Parses a configuration module as syntax only; nothing is loaded or evaluated. */
function parseConfig(content: BlobContent): ParsedConfig | null {
  if (content.text === null) return null;
  const file = content.entry.path;
  const kind = file.endsWith(".ts") || file.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file, content.text, ts.ScriptTarget.Latest, true, kind);
  let exported: ts.Expression | null = null;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) exported = statement.expression;
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && statement.expression.left.getText() === "module.exports") {
      exported = statement.expression.right;
    }
  }
  let config = exported;
  while (config !== null && (ts.isParenthesizedExpression(config) || ts.isAsExpression(config) || ts.isSatisfiesExpression(config) || (ts.isCallExpression(config) && config.expression.getText() === "defineConfig" && config.arguments[0] !== undefined))) {
    config = ts.isCallExpression(config) ? config.arguments[0]! : config.expression;
  }
  return { sourceFile, directory: path.posix.dirname(file) === "." ? "" : path.posix.dirname(file), config };
}

async function configEntries(tool: string, configPath: string, content: BlobContent, parsed: ParsedConfig, index: ProjectIndex, context: DetectorContext): Promise<ConfigEntry[]> {
  const { config } = parsed;
  if (config === null) return [];
  if (!ts.isObjectLiteralExpression(config)) return [{ name: "main", resolved: computed(config), reasoning: "", content }];
  const property = tool === "vite" ? nested(config, ["build", "rollupOptions", "input"]) ?? nested(config, ["build", "lib", "entry"]) : nested(config, ["entry"]);
  if (property !== undefined) {
    return entryNodes(property).map(([name, node]) => {
      const resolved = resolvePath(node, parsed);
      return { name, resolved, reasoning: idiomReasoning(resolved), content };
    });
  }
  if (tool === "vite") return viteHtmlEntries(parsed, context);
  const defaults = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].map((extension) => path.posix.join(parsed.directory, `src/index${extension}`));
  const module = defaults.find((candidate) => index.modules.some((entry) => entry.path === candidate));
  if (module === undefined) return [];
  return [{ name: "main", resolved: { module, resolution: "default", expression: null, lines: linesOf(config) }, reasoning: `${tool} uses ./src/index when ${configPath} names no entry`, content }];
}

/** Vite's default entry: module scripts in the index.html beside its configuration. */
async function viteHtmlEntries(parsed: ParsedConfig, context: DetectorContext): Promise<ConfigEntry[]> {
  const html = await context.text(path.posix.join(parsed.directory, "index.html"));
  if (html === null) return [];
  const entries: ConfigEntry[] = [];
  const lines = html.text!.split("\n");
  for (const [position, line] of lines.entries()) {
    for (const tag of line.match(/<script\b[^>]*>/gi) ?? []) {
      const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (!/\btype\s*=\s*["']module["']/i.test(tag) || source === undefined || /^[a-z][a-z0-9+.-]*:/i.test(source)) continue;
      entries.push({
        name: `${html.entry.path}#${entries.length}`,
        resolved: { module: normalize(parsed.directory, source), resolution: "literal", expression: null, lines: { start: position + 1, end: position + 1 } },
        reasoning: "",
        content: html,
      });
    }
  }
  return entries;
}

function entryNodes(node: ts.Expression): [string, ts.Expression][] {
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property): [string, ts.Expression][] => {
      if (!ts.isPropertyAssignment(property)) return [];
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : property.name.getText();
      const value = property.initializer;
      if (ts.isObjectLiteralExpression(value)) {
        const imported = nested(value, ["import"]);
        return imported === undefined ? [[name, value]] : entryNodes(imported).map(([, node]) => [name, node]);
      }
      if (ts.isArrayLiteralExpression(value)) return value.elements.map((element, position) => [`${name}[${position}]`, element]);
      return [[name, value]];
    });
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element, position) => [`main[${position}]`, element]);
  return [["main", node]];
}

function nested(object: ts.ObjectLiteralExpression, keys: readonly string[]): ts.Expression | undefined {
  let current: ts.Expression = object;
  for (const key of keys) {
    if (!ts.isObjectLiteralExpression(current)) return undefined;
    const property = current.properties.find((candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate) && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === key);
    if (property === undefined) return undefined;
    current = property.initializer;
  }
  return current;
}

/** Finds `exposes: { "./Key": "./path" }` anywhere in a configuration module. */
function exposesOf(parsed: ParsedConfig): Map<string, ResolvedPath> {
  const mapping = new Map<string, ResolvedPath>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "exposes" && ts.isObjectLiteralExpression(node.initializer)) {
      for (const [key, value] of entryNodes(node.initializer)) mapping.set(key, resolvePath(value, parsed));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.sourceFile);
  return mapping;
}

/**
 * A literal path, or one of the idioms that name a file relative to the
 * configuration: `path.resolve(__dirname, "...")`, `path.join(__dirname, ...)`,
 * and `new URL("...", import.meta.url)`. Anything else is computed.
 */
function resolvePath(node: ts.Expression, parsed: ParsedConfig): ResolvedPath {
  if (ts.isStringLiteralLike(node)) return { module: normalize(parsed.directory, node.text), resolution: "literal", expression: null, lines: linesOf(node) };
  let current: ts.Expression = node;
  if (ts.isCallExpression(current) && current.expression.getText().endsWith("fileURLToPath") && current.arguments[0] !== undefined) current = current.arguments[0];
  if (ts.isNewExpression(current) && current.expression.getText() === "URL" && current.arguments?.length === 2 && ts.isStringLiteralLike(current.arguments[0]!) && current.arguments[1]!.getText() === "import.meta.url") {
    return { module: normalize(parsed.directory, current.arguments[0].text), resolution: "idiom", expression: node.getText(), lines: linesOf(node) };
  }
  if (ts.isCallExpression(current) && ["path.resolve", "path.join", "resolve", "join"].includes(current.expression.getText())) {
    const [first, ...rest] = current.arguments;
    if (first !== undefined && first.getText() === "__dirname" && rest.length > 0 && rest.every((argument) => ts.isStringLiteralLike(argument))) {
      return { module: normalize(parsed.directory, rest.map((argument) => (argument as ts.StringLiteralLike).text).join("/")), resolution: "idiom", expression: node.getText(), lines: linesOf(node) };
    }
  }
  return computed(node);
}

function computed(node: ts.Expression): ResolvedPath {
  return { module: null, resolution: "computed", expression: node.getText().slice(0, 200), lines: linesOf(node) };
}

function idiomReasoning(resolved: ResolvedPath): string {
  return resolved.resolution === "idiom" ? `${resolved.expression ?? "The expression"} names a file relative to the configuration file` : "";
}

function normalize(directory: string, target: string): string | null {
  const joined = path.posix.normalize(path.posix.join(directory, target.replace(/^\//, "")));
  return joined.startsWith("..") ? null : joined;
}

function nextRoute(file: string): { path: string; reasoning: string } | null {
  const app = /^(?:src\/)?app\/(.*)\/?page\.[cm]?[jt]sx?$/.exec(file) ?? /^(?:src\/)?app\/page\.[cm]?[jt]sx?$/.exec(file);
  if (app !== null) {
    const segments = (app[1] ?? "").split("/").filter((segment) => segment !== "" && !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
    return { path: `/${segments.join("/")}`, reasoning: "Next.js maps a page file under app/ to the route named by its directories" };
  }
  const pages = /^(?:src\/)?pages\/(.+)\.[cm]?[jt]sx?$/.exec(file);
  if (pages === null) return null;
  const route = pages[1]!;
  if (route.startsWith("api/") || route.startsWith("_")) return null;
  const segments = route.split("/").filter((segment) => segment !== "index");
  return { path: `/${segments.join("/")}`, reasoning: "Next.js maps a file under pages/ to the route named by its path" };
}
