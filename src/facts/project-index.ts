import path from "node:path";
import { type SourceReader, compareCodeUnits, isSensitivePath } from "@repo-facts/contract";
import ts from "typescript";
import { digestDocument } from "../contracts/index.js";

/**
 * Web Doctor's product-owned source index: modules, imports, exports,
 * top-level symbols, React components with their props, hooks, rendered
 * elements, contexts and providers, and references between symbols.
 *
 * The index runs TypeScript compiler services with `allowJs` over a virtual
 * root. Every byte comes from files the SourceReader admitted; module
 * resolution sees only those files; `tsconfig.json` and `jsconfig.json` are
 * parsed as data for path aliases. Nothing is executed, no library typings
 * are loaded, and no real filesystem path is ever consulted.
 */

export const PROJECT_INDEX_SCHEMA = "web-doctor.project-index";
export const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const VIRTUAL_ROOT = "/web-doctor-source";

export interface ProjectIndexLimits {
  maxFiles: number;
  maxSymbols: number;
  maxReferences: number;
}

export const DEFAULT_INDEX_LIMITS: ProjectIndexLimits = { maxFiles: 4_000, maxSymbols: 20_000, maxReferences: 200_000 };

export interface IndexLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export type IndexSymbolKind = "component" | "hook" | "context" | "function" | "class" | "variable" | "type" | "interface" | "enum";
export type IndexCertainty = "observed" | "inferred" | "unknown";

export interface IndexedProp {
  name: string;
  optional: boolean;
  source: "destructuring" | "type" | "prop-types" | "usage";
  location: IndexLocation | null;
}

/** A hook call or rendered element, resolved to an indexed symbol or a package when possible. */
export interface IndexedUse {
  name: string;
  symbol: string | null;
  module: string | null;
  location: IndexLocation;
}

/** A function, object, or array literal passed as a prop, which is a new value on every render. */
export interface InlineProp {
  element: IndexedUse;
  attribute: string;
  kind: "function" | "object" | "array";
  location: IndexLocation;
}

export interface IndexedSymbol {
  id: string;
  name: string;
  kind: IndexSymbolKind;
  path: string;
  location: IndexLocation;
  exported: boolean;
  certainty: "observed" | "inferred";
  reasoning: string | null;
  props: IndexedProp[] | null;
  propsCertainty: IndexCertainty | null;
  hooks: IndexedUse[];
  renders: IndexedUse[];
  /** Context symbols this symbol renders a provider for. */
  provides: string[];
  /** Context symbols this symbol reads. */
  consumes: string[];
  /** Whether the declaration is wrapped in React memo, an optimization boundary for props. */
  memoized: boolean;
  inlineProps: InlineProp[];
}

export type ImportTarget =
  | { kind: "module"; path: string }
  | { kind: "asset"; path: string }
  | { kind: "package"; name: string }
  | { kind: "unresolved"; reason: "computed_specifier" | "not_found" };

export interface IndexedImport {
  specifier: string | null;
  kind: "static" | "dynamic" | "require" | "reexport";
  typeOnly: boolean;
  names: { imported: string; local: string }[];
  target: ImportTarget;
  location: IndexLocation;
  /** The top-level symbol containing a dynamic import or require; null for module-level imports. */
  enclosing: string | null;
}

export interface IndexedExport {
  name: string;
  symbol: string | null;
  from: string | null;
}

export interface IndexedModule {
  path: string;
  objectId: string;
  imports: IndexedImport[];
  exports: IndexedExport[];
  syntaxErrors: number;
}

export type ReferenceKind = "jsx" | "call" | "import" | "export" | "type" | "value";

export interface IndexedReference {
  symbol: string;
  path: string;
  kind: ReferenceKind;
  location: IndexLocation;
  /** The top-level symbol whose declaration contains the reference. */
  enclosing: string | null;
  /** For a JSX reference, the attribute names written on the element; `...` marks a spread. */
  attributes: string[] | null;
}

export interface IndexSkip {
  path: string;
  reason: string;
  detail: string;
}

/** A statically written value, or the fact that it is computed and not resolved. */
export type StaticValue = { kind: "literal"; value: string } | { kind: "computed"; expression: string };

/** A React root: createRoot, hydrateRoot, or legacy render/hydrate from react-dom. */
export interface IndexedMount {
  path: string;
  api: "createRoot" | "hydrateRoot" | "render" | "hydrate";
  module: string;
  component: IndexedUse | null;
  container: StaticValue | null;
  location: IndexLocation;
  enclosing: string | null;
}

export interface IndexedRoute {
  path: string;
  router: string;
  style: "element" | "object";
  routePath: StaticValue | null;
  index: boolean;
  element: IndexedUse | null;
  /** The location key (`path:line:column`) of the enclosing route, when nested. */
  parent: string | null;
  location: IndexLocation;
}

export interface IndexedLifecycles {
  path: string;
  module: string;
  rootComponent: IndexedUse | null;
  lifecycles: string[];
  location: IndexLocation;
}

export interface IndexedFrame {
  path: string;
  src: StaticValue | null;
  enclosing: string | null;
  location: IndexLocation;
}

export interface IndexedMessage {
  path: string;
  direction: "send" | "receive";
  enclosing: string | null;
  location: IndexLocation;
}

/** A call into React's own packages, with the exact module it was imported from. */
export interface IndexedApiCall {
  path: string;
  module: string;
  name: string;
  location: IndexLocation;
  enclosing: string | null;
}

/** A React pattern that newer major versions deprecate or remove. */
export interface IndexedLegacyPattern {
  path: string;
  kind: "string-ref" | "function-default-props" | "function-prop-types" | "legacy-context";
  symbol: string | null;
  location: IndexLocation;
}

export interface IndexedRuntime {
  mounts: IndexedMount[];
  routes: IndexedRoute[];
  lifecycles: IndexedLifecycles[];
  frames: IndexedFrame[];
  messages: IndexedMessage[];
  apiCalls: IndexedApiCall[];
  legacy: IndexedLegacyPattern[];
}

export interface ProjectIndex {
  schema: typeof PROJECT_INDEX_SCHEMA;
  schemaVersion: 1;
  compiler: { name: "typescript"; version: string };
  limits: ProjectIndexLimits;
  complete: boolean;
  truncated: { files: boolean; symbols: boolean; references: boolean };
  totals: { files: number; symbols: number; references: number };
  modules: IndexedModule[];
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  runtime: IndexedRuntime;
  skipped: IndexSkip[];
  digest: string;
}

export interface ProjectIndexOptions {
  limits?: Partial<ProjectIndexLimits>;
  /** Reuses parsed source files across rebuilds in a long-running process. */
  session?: IndexSession;
}

/**
 * Keeps TypeScript's document registry, and the previous language service
 * holding its documents, between rebuilds, so files whose object id did not
 * change are not parsed again.
 */
export class IndexSession {
  readonly registry = ts.createDocumentRegistry(true, VIRTUAL_ROOT);
  private previous: ts.LanguageService | undefined;

  replace(service: ts.LanguageService): void {
    this.previous?.dispose();
    this.previous = service;
  }

  dispose(): void {
    this.previous?.dispose();
    this.previous = undefined;
  }
}

interface Declared {
  id: string;
  name: string;
  node: ts.Node;
  body: ts.Node | null;
  statement: ts.Statement;
  file: string;
}

export function isSourcePath(file: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)) && !isSensitivePath(file);
}

export async function buildProjectIndex(reader: SourceReader, options: ProjectIndexOptions = {}): Promise<ProjectIndex> {
  const limits = { ...DEFAULT_INDEX_LIMITS, ...options.limits };
  const skipped: IndexSkip[] = [];
  const candidates = reader.files().map((entry) => entry.path).filter(isSourcePath);
  const admitted = candidates.slice(0, limits.maxFiles);
  for (const file of candidates.slice(limits.maxFiles)) skipped.push({ path: file, reason: "index_file_budget", detail: `The index reads at most ${limits.maxFiles} source files` });
  const configs = reader.files().map((entry) => entry.path).filter((file) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(file));

  const texts = new Map<string, string>();
  for (const [file, result] of await reader.readMany([...admitted, ...configs])) {
    if (!result.ok) {
      if (admitted.includes(file)) skipped.push({ path: file, reason: result.skip.reason, detail: result.skip.detail });
    } else if (result.content.text === null) {
      if (admitted.includes(file)) skipped.push({ path: file, reason: "binary", detail: "Binary content is not parsed" });
    } else texts.set(file, result.content.text);
  }
  const sources = admitted.filter((file) => texts.has(file));
  const assets = new Set(reader.files().map((entry) => entry.path));
  const host = new ReaderHost(texts, sources, configs.filter((file) => texts.has(file)), (file) => reader.entry(file)?.objectId ?? "");
  const service = ts.createLanguageService(host, options.session?.registry ?? ts.createDocumentRegistry(true, VIRTUAL_ROOT));
  const program = service.getProgram();
  if (program === undefined) throw new Error("TypeScript produced no program");
  const checker = program.getTypeChecker();
  const indexer = new Indexer(program, checker, host, assets, limits);
  const result = indexer.run(sources.filter((file) => !file.endsWith(".d.ts")));
  if (options.session !== undefined) options.session.replace(service);
  else service.dispose();
  for (const [file, count] of result.syntaxErrors) {
    if (count > 0) skipped.push({ path: file, reason: "syntax_error", detail: `${count} syntax errors; declarations after an error may be missing` });
  }

  const payload = {
    schema: PROJECT_INDEX_SCHEMA as typeof PROJECT_INDEX_SCHEMA,
    schemaVersion: 1 as const,
    compiler: { name: "typescript" as const, version: ts.version },
    limits,
    complete: skipped.length === 0 && !result.truncated.symbols && !result.truncated.references,
    truncated: { files: candidates.length > admitted.length, ...result.truncated },
    totals: { files: candidates.length, symbols: result.totals.symbols, references: result.totals.references },
    modules: result.modules,
    symbols: result.symbols,
    references: result.references,
    runtime: result.runtime,
    skipped: skipped.sort((left, right) => compareCodeUnits(left.path, right.path) || compareCodeUnits(left.reason, right.reason)),
  };
  return { ...payload, digest: digestDocument(payload).digest };
}

/** A LanguageServiceHost whose only files are the reader's admitted texts. */
class ReaderHost implements ts.LanguageServiceHost {
  private readonly directories = new Set<string>([VIRTUAL_ROOT]);
  private readonly resolutionOptions = new Map<string, ts.CompilerOptions>();
  readonly baseOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noEmit: true,
    types: [],
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: false,
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ESNext,
  };

  constructor(
    private readonly texts: ReadonlyMap<string, string>,
    private readonly sources: readonly string[],
    configs: readonly string[],
    private readonly versionOf: (file: string) => string,
  ) {
    for (const file of texts.keys()) {
      for (let directory = path.posix.dirname(virtual(file)); directory.startsWith(VIRTUAL_ROOT); directory = path.posix.dirname(directory)) {
        this.directories.add(directory);
        if (directory === VIRTUAL_ROOT) break;
      }
    }
    for (const config of configs) {
      const options = this.parseConfig(config);
      if (options !== undefined) this.resolutionOptions.set(path.posix.dirname(config), options);
    }
  }

  getCompilationSettings(): ts.CompilerOptions {
    return this.baseOptions;
  }

  getScriptFileNames(): string[] {
    return this.sources.map(virtual);
  }

  getScriptVersion(fileName: string): string {
    return this.versionOf(relative(fileName));
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const text = this.readFile(fileName);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  }

  getCurrentDirectory(): string {
    return VIRTUAL_ROOT;
  }

  getDefaultLibFileName(): string {
    return `${VIRTUAL_ROOT}/.web-doctor-no-lib.d.ts`;
  }

  useCaseSensitiveFileNames(): boolean {
    return true;
  }

  fileExists(fileName: string): boolean {
    return fileName.startsWith(`${VIRTUAL_ROOT}/`) && this.texts.has(relative(fileName));
  }

  readFile(fileName: string): string | undefined {
    return fileName.startsWith(`${VIRTUAL_ROOT}/`) ? this.texts.get(relative(fileName)) : undefined;
  }

  directoryExists(directoryName: string): boolean {
    return this.directories.has(directoryName.replace(/\/$/, ""));
  }

  getDirectories(directoryName: string): string[] {
    const prefix = `${directoryName.replace(/\/$/, "")}/`;
    return [...this.directories].filter((directory) => directory.startsWith(prefix) && !directory.slice(prefix.length).includes("/")).map((directory) => directory.slice(prefix.length));
  }

  realpath(fileName: string): string {
    return fileName;
  }

  resolveModuleNameLiterals(literals: readonly ts.StringLiteralLike[], containingFile: string): ts.ResolvedModuleWithFailedLookupLocations[] {
    return literals.map((literal) => this.resolve(literal.text, containingFile));
  }

  resolve(specifier: string, containingFile: string): ts.ResolvedModuleWithFailedLookupLocations {
    return ts.resolveModuleName(specifier, containingFile, this.optionsFor(containingFile), this);
  }

  private optionsFor(containingFile: string): ts.CompilerOptions {
    for (let directory = path.posix.dirname(relative(containingFile)); ; directory = path.posix.dirname(directory)) {
      const key = directory === "." ? "." : directory;
      const options = this.resolutionOptions.get(key);
      if (options !== undefined) return options;
      if (key === ".") return this.baseOptions;
    }
  }

  /** Reads path-mapping options from a config file as data; other settings are ignored. */
  private parseConfig(config: string): ts.CompilerOptions | undefined {
    const parsed = ts.parseConfigFileTextToJson(virtual(config), this.texts.get(config) ?? "");
    if (parsed.error !== undefined || typeof parsed.config !== "object" || parsed.config === null) return undefined;
    const content = ts.parseJsonConfigFileContent(parsed.config, {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: (file) => this.fileExists(file),
      readFile: (file) => this.readFile(file),
    }, path.posix.dirname(virtual(config)), undefined, virtual(config));
    const options: ts.CompilerOptions = { ...this.baseOptions };
    for (const key of ["baseUrl", "paths", "pathsBasePath", "rootDirs", "moduleSuffixes", "customConditions"] as const) {
      if (content.options[key] !== undefined) (options as Record<string, unknown>)[key] = content.options[key];
    }
    return options;
  }
}

class Indexer {
  private readonly declarations = new Map<ts.Node, Declared>();
  private readonly byStatement = new Map<ts.Statement, string>();
  private readonly symbols = new Map<string, IndexedSymbol>();
  private readonly references: IndexedReference[] = [];
  private readonly runtime: IndexedRuntime = { mounts: [], routes: [], lifecycles: [], frames: [], messages: [], apiCalls: [], legacy: [] };
  private referenceTotal = 0;

  constructor(
    private readonly program: ts.Program,
    private readonly checker: ts.TypeChecker,
    private readonly host: ReaderHost,
    private readonly assets: ReadonlySet<string>,
    private readonly limits: ProjectIndexLimits,
  ) {}

  run(files: readonly string[]) {
    const sourceFiles = files.map((file) => [file, this.program.getSourceFile(virtual(file))] as const).filter((entry): entry is readonly [string, ts.SourceFile] => entry[1] !== undefined);
    let symbolTotal = 0;
    for (const [file, sourceFile] of sourceFiles) {
      for (const declared of this.declare(file, sourceFile)) {
        symbolTotal++;
        if (this.declarations.size < this.limits.maxSymbols) {
          this.declarations.set(declared.node, declared);
          this.byStatement.set(declared.statement, declared.id);
        }
      }
    }
    for (const declared of this.declarations.values()) this.symbols.set(declared.id, this.describe(declared));
    const modules: IndexedModule[] = [];
    const syntaxErrors = new Map<string, number>();
    for (const [file, sourceFile] of sourceFiles) {
      const exports = this.exportsOf(sourceFile);
      for (const exported of exports) {
        const symbol = exported.symbol === null ? undefined : this.symbols.get(exported.symbol);
        if (symbol !== undefined && symbol.path === file) symbol.exported = true;
      }
      const errors = this.program.getSyntacticDiagnostics(sourceFile).length;
      syntaxErrors.set(file, errors);
      modules.push({
        path: file,
        objectId: this.host.getScriptVersion(virtual(file)),
        imports: this.importsOf(file, sourceFile),
        exports,
        syntaxErrors: errors,
      });
      this.collectReferences(file, sourceFile);
      this.collectRuntime(file, sourceFile);
    }
    const references = this.references.sort(compareReferences).slice(0, this.limits.maxReferences);
    return {
      modules,
      symbols: [...this.symbols.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
      references,
      runtime: this.runtime,
      syntaxErrors,
      truncated: { symbols: symbolTotal > this.limits.maxSymbols, references: this.referenceTotal > this.limits.maxReferences },
      totals: { symbols: symbolTotal, references: this.referenceTotal },
    };
  }

  /** Top-level declarations with stable ids: `path#name`, suffixed with a position when a name repeats. */
  private declare(file: string, sourceFile: ts.SourceFile): Declared[] {
    const found: Omit<Declared, "id">[] = [];
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        found.push({ name: statement.name?.text ?? "default", node: statement, body: statement, statement, file });
      } else if (ts.isClassDeclaration(statement)) {
        found.push({ name: statement.name?.text ?? "default", node: statement, body: statement, statement, file });
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) found.push({ name: declaration.name.text, node: declaration, body: declaration.initializer ?? null, statement, file });
          else for (const element of bindingElements(declaration.name)) found.push({ name: element.name.text, node: element, body: null, statement, file });
        }
      } else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        found.push({ name: statement.name.text, node: statement, body: null, statement, file });
      } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && !ts.isIdentifier(statement.expression)) {
        found.push({ name: "default", node: statement, body: statement.expression, statement, file });
      }
    }
    const counts = new Map<string, number>();
    for (const entry of found) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    return found.map((entry) => {
      const location = locationOf(file, nameNodeOf(entry.node));
      return { ...entry, id: counts.get(entry.name)! > 1 ? `${file}#${entry.name}@${location.line}:${location.column}` : `${file}#${entry.name}` };
    });
  }

  private describe(declared: Declared): IndexedSymbol {
    const { node, name } = declared;
    const target = declared.body === null ? null : unwrap(declared.body);
    let kind: IndexSymbolKind;
    let certainty: IndexedSymbol["certainty"] = "observed";
    let reasoning: string | null = null;
    if (ts.isInterfaceDeclaration(node)) kind = "interface";
    else if (ts.isTypeAliasDeclaration(node)) kind = "type";
    else if (ts.isEnumDeclaration(node)) kind = "enum";
    else if (ts.isClassDeclaration(node)) {
      if (extendsReactComponent(node)) {
        kind = "component";
        certainty = "inferred";
        reasoning = "The class extends React.Component or PureComponent";
      } else kind = "class";
    } else if (target !== null && isContextCreation(target)) {
      kind = "context";
    } else if (target !== null && (isFunctionLike(target) || ts.isFunctionDeclaration(node))) {
      const wrapped = declared.body !== null && isComponentWrapper(declared.body);
      if (/^use[A-Z0-9]/.test(name)) {
        kind = "hook";
        certainty = "inferred";
        reasoning = "The function is named with the use prefix that marks React hooks";
      } else if ((/^[A-Z]/.test(name) || name === "default") && (wrapped || containsJsx(target))) {
        kind = "component";
        certainty = "inferred";
        reasoning = wrapped ? "The function is wrapped in React memo or forwardRef" : "A capitalized or default-exported function that returns JSX";
      } else kind = "function";
    } else if (target !== null && isHigherOrderComponent(target)) {
      kind = "component";
      certainty = "inferred";
      reasoning = "A with* higher-order function wraps a capitalized component";
    } else kind = "variable";

    const symbol: IndexedSymbol = {
      id: declared.id,
      name,
      kind,
      path: declared.file,
      location: locationOf(declared.file, nameNodeOf(node)),
      exported: hasExportModifier(declared.statement),
      certainty,
      reasoning,
      props: null,
      propsCertainty: null,
      hooks: [],
      renders: [],
      provides: [],
      consumes: [],
      memoized: declared.body !== null && isMemo(declared.body),
      inlineProps: [],
    };
    const scope = ts.isClassDeclaration(node) ? node : target;
    if (scope !== null && (kind === "component" || kind === "hook" || kind === "function")) this.analyzeBody(declared.file, scope, symbol);
    if (kind === "component") this.analyzeProps(declared, target, symbol);
    return symbol;
  }

  private analyzeBody(file: string, scope: ts.Node, symbol: IndexedSymbol): void {
    const hooks = new Map<string, IndexedUse>();
    const renders = new Map<string, IndexedUse>();
    const inlineProps: InlineProp[] = [];
    const provides = new Set<string>();
    const consumes = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = calleeName(node.expression);
        if (callee !== null && (/^use[A-Z0-9]/.test(callee) || callee === "use")) {
          const resolved = this.resolveUse(node.expression);
          const key = `${callee}\0${resolved.symbol ?? ""}\0${resolved.module ?? ""}`;
          if (!hooks.has(key)) hooks.set(key, { name: callee, ...resolved, location: locationOf(file, node.expression) });
          if ((callee === "useContext" || callee === "use") && node.arguments[0] !== undefined) {
            const context = this.contextOf(node.arguments[0]);
            if (context !== null) consumes.add(context);
          }
        }
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        const tagText = tag.getText();
        if (ts.isPropertyAccessExpression(tag) && (tag.name.text === "Provider" || tag.name.text === "Consumer")) {
          const context = this.contextOf(tag.expression);
          if (context !== null) (tag.name.text === "Provider" ? provides : consumes).add(context);
        } else if (ts.isIdentifier(tag) && this.contextOf(tag) !== null) {
          provides.add(this.contextOf(tag)!);
        }
        if (/^[A-Z]/.test(tagText) || ts.isPropertyAccessExpression(tag)) {
          const resolved = this.resolveUse(tag);
          const use = { name: tagText, ...resolved, location: locationOf(file, tag) };
          const key = `${tagText}\0${resolved.symbol ?? ""}\0${resolved.module ?? ""}`;
          if (!renders.has(key)) renders.set(key, use);
          for (const property of node.attributes.properties) {
            if (!ts.isJsxAttribute(property) || property.initializer === undefined || !ts.isJsxExpression(property.initializer) || property.initializer.expression === undefined) continue;
            const value = unwrapParentheses(property.initializer.expression);
            const kind = ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? "function" : ts.isObjectLiteralExpression(value) ? "object" : ts.isArrayLiteralExpression(value) ? "array" : null;
            if (kind !== null) inlineProps.push({ element: use, attribute: property.name.getText(), kind, location: locationOf(file, property) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    symbol.hooks = [...hooks.values()].sort(compareUses);
    symbol.renders = [...renders.values()].sort(compareUses);
    symbol.provides = [...provides].sort(compareCodeUnits);
    symbol.consumes = [...consumes].sort(compareCodeUnits);
    symbol.inlineProps = inlineProps;
  }

  private analyzeProps(declared: Declared, target: ts.Node | null, symbol: IndexedSymbol): void {
    const file = declared.file;
    const props = new Map<string, IndexedProp>();
    let certainty: IndexCertainty = "unknown";
    const add = (prop: IndexedProp) => {
      if (!props.has(prop.name)) props.set(prop.name, prop);
    };
    const component = target !== null && isFunctionLike(target) ? target : null;
    const parameter = component?.parameters[0];
    for (const statement of declared.statement.getSourceFile().statements) {
      const assigned = propTypesAssignment(statement, declared.name);
      if (assigned === null) continue;
      certainty = "observed";
      for (const property of assigned.properties) {
        if (property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          add({ name: property.name.text, optional: !property.getText().includes("isRequired"), source: "prop-types", location: locationOf(file, property) });
        }
      }
    }
    if (parameter !== undefined) {
      if (ts.isObjectBindingPattern(parameter.name)) {
        certainty = "observed";
        for (const element of parameter.name.elements) {
          if (element.dotDotDotToken !== undefined) {
            certainty = "inferred";
            continue;
          }
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) add({ name: key.text, optional: element.initializer !== undefined, source: "destructuring", location: locationOf(file, element) });
        }
      }
      if (parameter.type !== undefined) {
        const type = this.checker.getTypeAtLocation(parameter.type);
        if ((type.flags & ts.TypeFlags.Any) === 0 && type.getProperties().length > 0) {
          if (certainty === "unknown") certainty = "observed";
          for (const property of type.getProperties()) {
            const declaration = property.declarations?.[0];
            add({
              name: property.name,
              optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
              source: "type",
              location: declaration !== undefined && declaration.getSourceFile().fileName.startsWith(VIRTUAL_ROOT) ? locationOf(relative(declaration.getSourceFile().fileName), declaration) : null,
            });
          }
        }
      } else if (ts.isIdentifier(parameter.name) && component !== null) {
        const propsName = parameter.name.text;
        const visit = (node: ts.Node): void => {
          if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === propsName) {
            add({ name: node.name.text, optional: true, source: "usage", location: locationOf(file, node) });
          }
          ts.forEachChild(node, visit);
        };
        visit(component);
        if (props.size > 0 && certainty === "unknown") certainty = "inferred";
      }
    }
    if (ts.isClassDeclaration(declared.node)) {
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === "props") {
          add({ name: node.name.text, optional: true, source: "usage", location: locationOf(file, node) });
        }
        ts.forEachChild(node, visit);
      };
      visit(declared.node);
      if (props.size > 0 && certainty === "unknown") certainty = "inferred";
    }
    symbol.props = [...props.values()].sort((left, right) => compareCodeUnits(left.name, right.name));
    // A function component that declares no parameter observably accepts no props.
    symbol.propsCertainty = component !== null && parameter === undefined ? "observed" : certainty;
  }

  private exportsOf(sourceFile: ts.SourceFile): IndexedExport[] {
    const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) return [];
    return this.checker.getExportsOfModule(moduleSymbol).map((exported) => {
      const target = this.aliasTarget(exported);
      const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
      const indexed = declaration === undefined ? undefined : this.declaredFor(declaration);
      const declarationFile = declaration?.getSourceFile().fileName;
      const from = declarationFile !== undefined && declarationFile !== sourceFile.fileName && declarationFile.startsWith(VIRTUAL_ROOT) ? relative(declarationFile) : null;
      return { name: exported.name, symbol: indexed?.id ?? null, from };
    }).sort((left, right) => compareCodeUnits(left.name, right.name));
  }

  private importsOf(file: string, sourceFile: ts.SourceFile): IndexedImport[] {
    const imports: IndexedImport[] = [];
    const enclosingOf = (node: ts.Node): string | null => {
      let current: ts.Node = node;
      while (current.parent !== undefined && current.parent !== sourceFile) current = current.parent;
      return current === node ? null : this.byStatement.get(current as ts.Statement) ?? null;
    };
    const add = (specifier: ts.Expression | undefined, kind: IndexedImport["kind"], typeOnly: boolean, names: IndexedImport["names"], site: ts.Node) => {
      const text = specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier.text : null;
      imports.push({
        specifier: text,
        kind,
        typeOnly,
        names,
        target: text === null ? { kind: "unresolved", reason: "computed_specifier" } : this.targetOf(text, sourceFile.fileName),
        location: locationOf(file, site),
        enclosing: enclosingOf(site),
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const names: IndexedImport["names"] = [];
        if (clause?.name !== undefined) names.push({ imported: "default", local: clause.name.text });
        const bindings = clause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push({ imported: "*", local: bindings.name.text });
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) names.push({ imported: (element.propertyName ?? element.name).text, local: element.name.text });
        }
        add(node.moduleSpecifier, "static", clause?.isTypeOnly === true, names, node);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        const names = node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((element) => ({ imported: (element.propertyName ?? element.name).text, local: element.name.text }))
          : [{ imported: "*", local: node.exportClause !== undefined && ts.isNamespaceExport(node.exportClause) ? node.exportClause.name.text : "*" }];
        add(node.moduleSpecifier, "reexport", node.isTypeOnly, names, node);
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], "dynamic", false, [], node);
        else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) add(node.arguments[0], "require", false, [], node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return imports;
  }

  private targetOf(specifier: string, containingFile: string): ImportTarget {
    const resolved = this.host.resolve(specifier, containingFile).resolvedModule;
    if (resolved !== undefined && resolved.resolvedFileName.startsWith(`${VIRTUAL_ROOT}/`)) return { kind: "module", path: relative(resolved.resolvedFileName) };
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(relative(containingFile)), specifier));
      return this.assets.has(candidate) ? { kind: "asset", path: candidate } : { kind: "unresolved", reason: "not_found" };
    }
    return { kind: "package", name: packageName(specifier) };
  }

  private collectReferences(file: string, sourceFile: ts.SourceFile): void {
    const enclosingOf = (node: ts.Node): string | null => {
      let current: ts.Node = node;
      while (current.parent !== undefined && current.parent !== sourceFile) current = current.parent;
      return this.byStatement.get(current as ts.Statement) ?? null;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isDeclarationName(node) && !inClosingTag(node)) {
        const symbol = this.checker.getSymbolAtLocation(node);
        const target = symbol === undefined ? undefined : this.aliasTarget(symbol);
        const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
        const declared = declaration === undefined ? undefined : this.declaredFor(declaration);
        if (declared !== undefined) {
          this.referenceTotal++;
          const kind = referenceKind(node);
          const element = node.parent;
          const attributes = kind === "jsx" && (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element))
            ? element.attributes.properties.map((property) => (ts.isJsxAttribute(property) ? property.name.getText() : "..."))
            : null;
          this.references.push({ symbol: declared.id, path: file, kind, location: locationOf(file, node), enclosing: enclosingOf(node), attributes });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  /**
   * Framework sites resolved through imports: React roots from react-dom,
   * React Router routes, single-spa-react lifecycles, frames, and message
   * channels. A same-named local function never counts.
   */
  private collectRuntime(file: string, sourceFile: ts.SourceFile): void {
    const enclosingOf = (node: ts.Node): string | null => {
      let current: ts.Node = node;
      while (current.parent !== undefined && current.parent !== sourceFile) current = current.parent;
      return this.byStatement.get(current as ts.Statement) ?? null;
    };
    const roots = new Map<string, IndexedMount>();
    const visit = (node: ts.Node, route: string | null): void => {
      let childRoute = route;
      this.collectLegacy(file, node, enclosingOf);
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        const origin = name === null ? null : this.resolveUse(node.expression).module;
        const specifier = name === null ? null : importSpecifierOf(this.checker, node.expression);
        if (name !== null && specifier !== null && /^react(?:-dom|-test-renderer)?(?:\/|$)/.test(specifier)) {
          this.runtime.apiCalls.push({ path: file, module: specifier, name, location: locationOf(file, node.expression), enclosing: enclosingOf(node) });
        }
        if ((name === "createRoot" || name === "hydrateRoot") && (origin === "react-dom" || origin === "react-dom/client")) {
          const mount: IndexedMount = {
            path: file,
            api: name,
            module: origin,
            component: name === "hydrateRoot" ? this.elementUse(file, node.arguments[1]) : null,
            container: containerOf(node.arguments[0]),
            location: locationOf(file, node),
            enclosing: enclosingOf(node),
          };
          this.runtime.mounts.push(mount);
          const holder = node.parent;
          if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) roots.set(holder.name.text, mount);
          if (ts.isPropertyAccessExpression(holder) && holder.name.text === "render" && ts.isCallExpression(holder.parent)) mount.component = this.elementUse(file, holder.parent.arguments[0]);
        } else if ((name === "render" || name === "hydrate") && origin === "react-dom") {
          this.runtime.mounts.push({
            path: file,
            api: name,
            module: origin,
            component: this.elementUse(file, node.arguments[0]),
            container: containerOf(node.arguments[1]),
            location: locationOf(file, node),
            enclosing: enclosingOf(node),
          });
        } else if (name === "render" && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && roots.has(node.expression.expression.text)) {
          const mount = roots.get(node.expression.expression.text)!;
          mount.component ??= this.elementUse(file, node.arguments[0]);
        } else if (name === "singleSpaReact" && origin === "single-spa-react") {
          const options = node.arguments[0];
          const rootComponent = options !== undefined && ts.isObjectLiteralExpression(options) ? propertyValue(options, "rootComponent") : undefined;
          this.runtime.lifecycles.push({
            path: file,
            module: origin,
            rootComponent: rootComponent === undefined ? null : { name: rootComponent.getText(), ...this.resolveUse(rootComponent), location: locationOf(file, rootComponent) },
            lifecycles: lifecycleExports(sourceFile),
            location: locationOf(file, node),
          });
        } else if (name !== null && ["createBrowserRouter", "createHashRouter", "createMemoryRouter", "useRoutes"].includes(name) && origin !== null && origin.startsWith("react-router")) {
          const routes = node.arguments[0];
          if (routes !== undefined && ts.isArrayLiteralExpression(routes)) this.objectRoutes(file, origin, routes, null);
        } else if (name === "postMessage") {
          this.runtime.messages.push({ path: file, direction: "send", enclosing: enclosingOf(node), location: locationOf(file, node) });
        } else if (name === "addEventListener" && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === "message") {
          this.runtime.messages.push({ path: file, direction: "receive", enclosing: enclosingOf(node), location: locationOf(file, node) });
        }
      } else if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        // Nested routes are children of the element, siblings of its opening tag.
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText();
        if (tag === "iframe") {
          this.runtime.frames.push({ path: file, src: attributeValue(opening, "src"), enclosing: enclosingOf(node), location: locationOf(file, opening) });
        } else if (tag === "Route" || tag.endsWith(".Route")) {
          const origin = this.resolveUse(opening.tagName).module;
          if (origin !== null && origin.startsWith("react-router")) {
            const location = locationOf(file, opening);
            const element = jsxAttribute(opening, "element") ?? jsxAttribute(opening, "component") ?? jsxAttribute(opening, "Component");
            this.runtime.routes.push({
              path: file,
              router: origin,
              style: "element",
              routePath: attributeValue(opening, "path"),
              index: jsxAttribute(opening, "index") !== undefined,
              element: element === undefined ? null : this.elementUse(file, element.initializer),
              parent: route,
              location,
            });
            childRoute = `${file}:${location.line}:${location.column}`;
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, childRoute));
    };
    visit(sourceFile, null);
  }

  /** Patterns React 18 deprecates and React 19 removes. */
  private collectLegacy(file: string, node: ts.Node, enclosingOf: (node: ts.Node) => string | null): void {
    const add = (kind: IndexedLegacyPattern["kind"], site: ts.Node, symbol: string | null) => this.runtime.legacy.push({ path: file, kind, symbol, location: locationOf(file, site) });
    if (ts.isJsxAttribute(node) && node.name.getText() === "ref" && node.initializer !== undefined && ts.isStringLiteral(node.initializer)) {
      add("string-ref", node, enclosingOf(node));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const property = node.left.name.text;
      const owner = this.resolveUse(node.left.expression).symbol;
      const declared = owner === null ? undefined : this.symbols.get(owner);
      const isClass = declared !== undefined && [...this.declarations.values()].some((entry) => entry.id === declared.id && ts.isClassDeclaration(entry.node));
      if (property === "contextTypes" || property === "childContextTypes") add("legacy-context", node, owner);
      else if (declared?.kind === "component" && !isClass && property === "defaultProps") add("function-default-props", node, owner);
      else if (declared?.kind === "component" && !isClass && property === "propTypes") add("function-prop-types", node, owner);
    } else if ((ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)) && ts.isIdentifier(node.name) && ["contextTypes", "childContextTypes", "getChildContext"].includes(node.name.text) && ts.isClassDeclaration(node.parent)) {
      add("legacy-context", node, enclosingOf(node));
    }
  }

  private objectRoutes(file: string, router: string, routes: ts.ArrayLiteralExpression, parent: string | null): void {
    for (const route of routes.elements) {
      if (!ts.isObjectLiteralExpression(route)) continue;
      const location = locationOf(file, route);
      const element = propertyValue(route, "element") ?? propertyValue(route, "Component") ?? propertyValue(route, "component");
      const pathValue = propertyValue(route, "path");
      const indexValue = propertyValue(route, "index");
      this.runtime.routes.push({
        path: file,
        router,
        style: "object",
        routePath: pathValue === undefined ? null : staticValue(pathValue),
        index: indexValue !== undefined && indexValue.kind === ts.SyntaxKind.TrueKeyword,
        element: element === undefined ? null : this.elementUse(file, element),
        parent,
        location,
      });
      const children = propertyValue(route, "children");
      if (children !== undefined && ts.isArrayLiteralExpression(children)) this.objectRoutes(file, router, children, `${file}:${location.line}:${location.column}`);
    }
  }

  /** The component a JSX element, `{<X />}` attribute, or component reference names. */
  private elementUse(file: string, node: ts.Node | undefined): IndexedUse | null {
    let current = node;
    while (current !== undefined && (ts.isJsxExpression(current) || ts.isParenthesizedExpression(current))) current = current.expression;
    if (current === undefined) return null;
    if (ts.isJsxElement(current)) current = current.openingElement;
    const tag = ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current) ? current.tagName : ts.isIdentifier(current) || ts.isPropertyAccessExpression(current) ? current : undefined;
    return tag === undefined ? null : { name: tag.getText(), ...this.resolveUse(tag), location: locationOf(file, tag) };
  }

  /** The indexed symbol an element tag or hook callee refers to, or the package it was imported from. */
  private resolveUse(expression: ts.Expression | ts.JsxTagNameExpression): { symbol: string | null; module: string | null } {
    let root: ts.Node = expression;
    const symbol = this.checker.getSymbolAtLocation(expression as ts.Node);
    const target = symbol === undefined ? undefined : this.aliasTarget(symbol);
    const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
    const declared = declaration === undefined ? undefined : this.declaredFor(declaration);
    if (declared !== undefined) return { symbol: declared.id, module: null };
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    const rootSymbol = ts.isIdentifier(root) ? this.checker.getSymbolAtLocation(root) : undefined;
    if (root !== expression && rootSymbol !== undefined) {
      const rootTarget = this.aliasTarget(rootSymbol);
      const rootDeclaration = rootTarget?.valueDeclaration ?? rootTarget?.declarations?.[0];
      const rootDeclared = rootDeclaration === undefined ? undefined : this.declaredFor(rootDeclaration);
      if (rootDeclared !== undefined) return { symbol: rootDeclared.id, module: null };
    }
    const importDeclaration = rootSymbol?.declarations?.map(importDeclarationOf).find((entry) => entry !== null);
    if (importDeclaration !== undefined && importDeclaration !== null && ts.isStringLiteral(importDeclaration.moduleSpecifier)) {
      const target = this.targetOf(importDeclaration.moduleSpecifier.text, importDeclaration.getSourceFile().fileName);
      return { symbol: null, module: target.kind === "package" ? target.name : target.kind === "module" || target.kind === "asset" ? target.path : importDeclaration.moduleSpecifier.text };
    }
    return { symbol: null, module: null };
  }

  private contextOf(expression: ts.Node): string | null {
    const symbol = this.checker.getSymbolAtLocation(expression);
    const target = symbol === undefined ? undefined : this.aliasTarget(symbol);
    const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
    const declared = declaration === undefined ? undefined : this.declaredFor(declaration);
    return declared !== undefined && this.symbols.get(declared.id)?.kind === "context" ? declared.id : null;
  }

  private declaredFor(declaration: ts.Node): Declared | undefined {
    return this.declarations.get(declaration);
  }

  private aliasTarget(symbol: ts.Symbol): ts.Symbol | undefined {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    try {
      const aliased = this.checker.getAliasedSymbol(symbol);
      return aliased.declarations === undefined ? undefined : aliased;
    } catch {
      return undefined;
    }
  }
}

function virtual(file: string): string {
  return `${VIRTUAL_ROOT}/${file}`;
}

function relative(fileName: string): string {
  return fileName.slice(VIRTUAL_ROOT.length + 1);
}

function locationOf(file: string, node: ts.Node): IndexLocation {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { path: file, line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 };
}

function nameNodeOf(node: ts.Node): ts.Node {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined) return node.name;
  if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return node.name;
  return node;
}

/** Identifiers bound by a destructuring declaration, in source order. */
function bindingElements(pattern: ts.BindingPattern): (ts.BindingElement & { name: ts.Identifier })[] {
  const elements: (ts.BindingElement & { name: ts.Identifier })[] = [];
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) elements.push(element as ts.BindingElement & { name: ts.Identifier });
    else elements.push(...bindingElements(element.name));
  }
  return elements;
}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isCallExpression(current) && isComponentWrapper(current) && current.arguments[0] !== undefined) current = current.arguments[0];
    else return current;
  }
}

function isFunctionLike(node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function isMemo(node: ts.Node): boolean {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return ts.isCallExpression(current) && calleeName(current.expression) === "memo";
}

function unwrapParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) current = current.expression;
  return current;
}

function isComponentWrapper(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  return name === "memo" || name === "forwardRef";
}

function isHigherOrderComponent(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  const argument = node.arguments[0];
  return name !== null && /^with[A-Z]/.test(name) && argument !== undefined && ts.isIdentifier(argument) && /^[A-Z]/.test(argument.text);
}

function isContextCreation(node: ts.Node): boolean {
  return ts.isCallExpression(node) && calleeName(node.expression) === "createContext";
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found || ts.isClassDeclaration(child)) return;
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function extendsReactComponent(node: ts.ClassDeclaration): boolean {
  return node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some((type) => {
    const name = calleeName(type.expression);
    return name === "Component" || name === "PureComponent";
  })) === true;
}

function hasExportModifier(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return true;
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function propTypesAssignment(statement: ts.Statement, name: string): ts.ObjectLiteralExpression | null {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const { left, right } = statement.expression;
  return ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === name && left.name.text === "propTypes" && ts.isObjectLiteralExpression(right) ? right : null;
}

function importDeclarationOf(declaration: ts.Declaration): ts.ImportDeclaration | null {
  let current: ts.Node | undefined = declaration;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) return current;
    current = current.parent;
  }
  return null;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent))
    && parent.name === node
  );
}

/** A string literal or no-substitution template; anything else is computed and left unresolved. */
function staticValue(node: ts.Node): StaticValue {
  if (ts.isStringLiteralLike(node)) return { kind: "literal", value: node.text };
  return { kind: "computed", expression: node.getText().slice(0, 200) };
}

function jsxAttribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name);
}

function attributeValue(element: ts.JsxOpeningLikeElement, name: string): StaticValue | null {
  const attribute = jsxAttribute(element, name);
  if (attribute === undefined) return null;
  const initializer = attribute.initializer;
  if (initializer === undefined) return { kind: "computed", expression: "true" };
  if (ts.isStringLiteral(initializer)) return { kind: "literal", value: initializer.text };
  if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) return staticValue(initializer.expression);
  return { kind: "computed", expression: initializer.getText().slice(0, 200) };
}

function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return undefined;
}

/** `document.getElementById("id")` and `document.querySelector("selector")` name a container literally. */
/** The module a call's root identifier was imported from, exactly as written. */
function importSpecifierOf(checker: ts.TypeChecker, expression: ts.Expression): string | null {
  let root: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (!ts.isIdentifier(root)) return null;
  const declaration = checker.getSymbolAtLocation(root)?.declarations?.map(importDeclarationOf).find((entry) => entry !== null);
  return declaration !== undefined && declaration !== null && ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : null;
}

function containerOf(node: ts.Node | undefined): StaticValue | null {
  if (node === undefined) return null;
  let current: ts.Node = node;
  while (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) current = current.expression;
  if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.arguments[0] !== undefined && ts.isStringLiteralLike(current.arguments[0])) {
    if (current.expression.name.text === "getElementById") return { kind: "literal", value: `#${current.arguments[0].text}` };
    if (current.expression.name.text === "querySelector") return { kind: "literal", value: current.arguments[0].text };
  }
  return { kind: "computed", expression: current.getText().slice(0, 200) };
}

function lifecycleExports(sourceFile: ts.SourceFile): string[] {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name !== undefined && ["bootstrap", "mount", "unmount", "update"].includes(statement.name.text)) names.add(statement.name.text);
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const identifiers = ts.isIdentifier(declaration.name) ? [declaration.name] : bindingElements(declaration.name).map((element) => element.name);
      for (const identifier of identifiers) if (["bootstrap", "mount", "unmount", "update"].includes(identifier.text)) names.add(identifier.text);
    }
  }
  return [...names].sort(compareCodeUnits);
}

function inClosingTag(node: ts.Identifier): boolean {
  let current: ts.Node = node;
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) current = current.parent;
  return ts.isJsxClosingElement(current.parent);
}

function referenceKind(node: ts.Identifier): ReferenceKind {
  const parent = node.parent;
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === node) return "jsx";
  if (ts.isCallExpression(parent) && parent.expression === node) return "call";
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return "import";
  if (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent)) return "export";
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent) || ts.isTypeQueryNode(parent)) return "type";
  return "value";
}

function packageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
}

function compareUses(left: IndexedUse, right: IndexedUse): number {
  return compareCodeUnits(left.name, right.name) || compareCodeUnits(left.symbol ?? "", right.symbol ?? "") || compareCodeUnits(left.module ?? "", right.module ?? "");
}

function compareReferences(left: IndexedReference, right: IndexedReference): number {
  return compareCodeUnits(left.symbol, right.symbol)
    || compareCodeUnits(left.path, right.path)
    || left.location.line - right.location.line
    || left.location.column - right.location.column;
}
