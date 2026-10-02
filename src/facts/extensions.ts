import {
  type CategoryDefinition,
  type Detector,
  type DocumentCategory,
  type FactDocument,
  SHARED_CATEGORIES,
  type SourceReader,
  categoriesFor,
  compareCodeUnits,
  defineExtension,
  digestOf,
  factDocumentProblems,
  runDetectors,
} from "@repo-facts/contract";
import { WEB_DOCTOR_VERSION } from "../version.js";
import { buildProjectIndex, type ProjectIndex, type ProjectIndexOptions } from "./project-index.js";
import { COMPONENTS, HOOKS, PROVIDERS, reactDetectors } from "./react-detectors.js";
import { ENTRY_POINTS, RELATIONSHIPS, ROUTES, TESTS, sourceDetectors } from "./source-detectors.js";

/**
 * Web Doctor's extension categories and the document that carries them.
 *
 * Extension facts use the shared detector contract but never enter the
 * shared fact document. Web Doctor runs its own detectors, with its own
 * release identifier, over a separate reader and keeps the resulting
 * extension document beside the unchanged shared one. Only the registered
 * `web-doctor.*` categories of that document are ever read.
 */

export const WEB_DOCTOR_EXTENSION_RELEASE = `web-doctor-extensions/${WEB_DOCTOR_VERSION}`;

export const WEB_DOCTOR_EXTENSIONS: readonly CategoryDefinition[] = [
  defineExtension({ id: COMPONENTS, label: "React components", group: "React", boundedNegative: true, description: "Components defined in application source, with props, hooks, and rendered elements" }),
  defineExtension({ id: HOOKS, label: "Custom hooks", group: "React", boundedNegative: true, description: "Custom React hooks defined in application source" }),
  defineExtension({ id: PROVIDERS, label: "Contexts and providers", group: "React", boundedNegative: true, description: "Contexts created in source with their providers and consumers, and package providers rendered by application components" }),
  defineExtension({ id: ENTRY_POINTS, label: "Entry points", group: "Application", boundedNegative: false, description: "Build-configuration entries, React roots, single-spa lifecycles, and federated exposes, with unresolved values kept unresolved" }),
  defineExtension({ id: TESTS, label: "Tests", group: "Verification", boundedNegative: true, description: "Test files with their frameworks, subjects, referenced symbols, and declared test commands" }),
  defineExtension({ id: ROUTES, label: "Routes", group: "Application", boundedNegative: false, description: "Routes declared through React Router or Next.js file conventions" }),
  defineExtension({ id: RELATIONSHIPS, label: "Source relationships", group: "Architecture", boundedNegative: false, description: "Source sites behind shared composition and runtime-integration facts: federated remote uses, frame hosts, and message channels" }),
].sort((left, right) => compareCodeUnits(left.id, right.id));

export interface ExtensionFacts {
  release: string;
  document: FactDocument;
  documentDigest: string;
  /** The registered extension categories of the extension document, and nothing else. */
  categories: Readonly<Record<string, DocumentCategory>>;
  index: ProjectIndex;
  /** Identity of the extension state: release, extension document, and index. */
  digest: string;
  usage: { files: number; bytes: number };
}

export interface ExtensionAnalysisOptions {
  index?: ProjectIndexOptions;
  /** The unchanged shared fact document, for extensions that build on shared facts. */
  shared?: FactDocument;
}

export type ExtensionDetectorFactory = (index: ProjectIndex, shared: FactDocument | undefined) => Detector[];

const DETECTOR_FACTORIES: ExtensionDetectorFactory[] = [(index) => reactDetectors(index), (index, shared) => sourceDetectors(index, shared)];

export async function analyzeExtensions(reader: SourceReader, options: ExtensionAnalysisOptions = {}): Promise<ExtensionFacts> {
  // Rejects any extension that is un-namespaced, repeated, or collides with a shared category.
  categoriesFor(WEB_DOCTOR_EXTENSIONS);
  const index = await buildProjectIndex(reader, options.index);
  const document = await runDetectors({
    reader,
    detectorRelease: WEB_DOCTOR_EXTENSION_RELEASE,
    detectors: DETECTOR_FACTORIES.flatMap((factory) => factory(index, options.shared)),
    extensions: WEB_DOCTOR_EXTENSIONS,
  });
  const problems = factDocumentProblems(document);
  if (problems.length > 0) throw new Error(`Web Doctor produced an invalid extension document:\n${problems.join("\n")}`);
  const documentDigest = digestOf(document).digest;
  const categories = Object.fromEntries(WEB_DOCTOR_EXTENSIONS.map((extension) => [extension.id, document.categories[extension.id]!]));
  return {
    release: WEB_DOCTOR_EXTENSION_RELEASE,
    document,
    documentDigest,
    categories,
    index,
    digest: extensionStateDigest(document, categories, index),
    usage: reader.usage(),
  };
}

/**
 * Identity of what the extensions assert: their categories, the evidence
 * those cite, diagnostics, and the index. The document's placeholder shared
 * categories and whole-tree inventory are carried by the shared document and
 * are not extension state.
 */
export function extensionStateDigest(document: FactDocument, categories: Readonly<Record<string, DocumentCategory>>, index: ProjectIndex): string {
  const cited = new Set(Object.values(categories).flatMap((category) => category.facts.flatMap((fact) => [...fact.evidence, ...(fact.candidates ?? []).flatMap((candidate) => candidate.evidence)])));
  return digestOf({
    release: WEB_DOCTOR_EXTENSION_RELEASE,
    extensions: document.extensions,
    categories,
    evidence: [...cited].sort().map((id) => document.evidence[id]!),
    diagnostics: document.diagnostics,
    index: index.digest,
  }).digest;
}

/**
 * Shared categories from the shared document and extension categories from
 * the extension document, side by side. A category id present in both is a
 * defect and is refused rather than overwritten.
 */
export function mergedCategories(shared: FactDocument, extensions: ExtensionFacts): Readonly<Record<string, DocumentCategory>> {
  const sharedIds = new Set(SHARED_CATEGORIES.map((category) => category.id));
  for (const id of Object.keys(extensions.categories)) {
    if (sharedIds.has(id) || Object.hasOwn(shared.categories, id)) throw new Error(`Extension category ${id} would overwrite a shared category`);
  }
  return { ...shared.categories, ...extensions.categories };
}
