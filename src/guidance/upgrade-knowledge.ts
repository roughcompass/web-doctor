import { digestDocument } from "../contracts/index.js";
import type { IndexedLegacyPattern } from "../facts/project-index.js";

/**
 * Versioned upgrade knowledge that ships with Web Doctor. It records only
 * what React itself defines: its release stages, the packages that must move
 * in lockstep with it, and the APIs each major version deprecates or
 * removes. Compatibility of other libraries comes from enterprise guidance
 * in the registry, never from this document.
 */

export interface UpgradeDetection {
  mounts?: ("render" | "hydrate")[];
  calls?: { module: string; names: string[] }[];
  imports?: { module: string; names?: string[] }[];
  legacy?: IndexedLegacyPattern["kind"][];
}

export interface UpgradeChange {
  id: string;
  title: string;
  status: "deprecated" | "removed" | "ignored";
  replacement: string;
  /** The first version where the replacement works, so the change can land before or with the upgrade. */
  availableFrom: string;
  detection: UpgradeDetection;
}

export interface UpgradeStage {
  version: string;
  purpose: string;
  changes: UpgradeChange[];
  /** Behavior to verify at runtime or by review; no static check establishes it. */
  review: string[];
}

export interface UpgradeKnowledge {
  schema: "web-doctor.upgrade-knowledge";
  schemaVersion: 1;
  id: string;
  version: string;
  package: string;
  /** The earliest version this knowledge plans from. */
  from: string;
  lockstep: { package: string; rule: "same-version" | "same-major" }[];
  stages: UpgradeStage[];
}

const reactDom = "react-dom";

export const REACT_UPGRADE_KNOWLEDGE: UpgradeKnowledge = {
  schema: "web-doctor.upgrade-knowledge",
  schemaVersion: 1,
  id: "react",
  version: "1.0.0",
  package: "react",
  from: "17.0.0",
  lockstep: [
    { package: "react-dom", rule: "same-version" },
    { package: "react-test-renderer", rule: "same-version" },
    { package: "@types/react", rule: "same-major" },
    { package: "@types/react-dom", rule: "same-major" },
  ],
  stages: [
    {
      version: "18.0.0",
      purpose: "Adopt the React 18 root API",
      changes: [
        { id: "react-dom-render", title: "ReactDOM.render", status: "deprecated", replacement: "createRoot from react-dom/client, then root.render", availableFrom: "18.0.0", detection: { mounts: ["render"], calls: [{ module: reactDom, names: ["render"] }] } },
        { id: "react-dom-hydrate", title: "ReactDOM.hydrate", status: "deprecated", replacement: "hydrateRoot from react-dom/client", availableFrom: "18.0.0", detection: { mounts: ["hydrate"], calls: [{ module: reactDom, names: ["hydrate"] }] } },
        { id: "unmount-component-at-node", title: "ReactDOM.unmountComponentAtNode", status: "deprecated", replacement: "root.unmount on the root createRoot returned", availableFrom: "18.0.0", detection: { calls: [{ module: reactDom, names: ["unmountComponentAtNode"] }] } },
        { id: "render-to-node-stream", title: "renderToNodeStream", status: "deprecated", replacement: "renderToPipeableStream", availableFrom: "18.0.0", detection: { calls: [{ module: "react-dom/server", names: ["renderToNodeStream"] }] } },
      ],
      review: [
        "Automatic batching now also batches updates outside React event handlers; check code that reads the DOM or state between updates",
        "Development StrictMode mounts, unmounts, and remounts components; confirm effects clean up after themselves",
        "React 18 type definitions no longer add children to component props implicitly; typecheck after upgrading",
      ],
    },
    {
      version: "18.3.0",
      purpose: "Surface warnings for APIs React 19 removes",
      changes: [],
      review: ["React 18.3 warns about APIs React 19 removes; run the tests and the application and resolve every new warning before continuing"],
    },
    {
      version: "19.0.0",
      purpose: "Remove APIs React 19 no longer supports",
      changes: [
        { id: "react-dom-render", title: "ReactDOM.render", status: "removed", replacement: "createRoot from react-dom/client, then root.render", availableFrom: "18.0.0", detection: { mounts: ["render"], calls: [{ module: reactDom, names: ["render"] }] } },
        { id: "react-dom-hydrate", title: "ReactDOM.hydrate", status: "removed", replacement: "hydrateRoot from react-dom/client", availableFrom: "18.0.0", detection: { mounts: ["hydrate"], calls: [{ module: reactDom, names: ["hydrate"] }] } },
        { id: "unmount-component-at-node", title: "ReactDOM.unmountComponentAtNode", status: "removed", replacement: "root.unmount on the root createRoot returned", availableFrom: "18.0.0", detection: { calls: [{ module: reactDom, names: ["unmountComponentAtNode"] }] } },
        { id: "find-dom-node", title: "ReactDOM.findDOMNode", status: "removed", replacement: "a ref on the element", availableFrom: "0.0.0", detection: { calls: [{ module: reactDom, names: ["findDOMNode"] }] } },
        { id: "string-refs", title: "String refs", status: "removed", replacement: "a callback ref or createRef", availableFrom: "0.0.0", detection: { legacy: ["string-ref"] } },
        { id: "legacy-context", title: "Legacy context (contextTypes and getChildContext)", status: "removed", replacement: "createContext with a Provider and useContext or contextType", availableFrom: "0.0.0", detection: { legacy: ["legacy-context"] } },
        { id: "function-default-props", title: "defaultProps on function components", status: "removed", replacement: "default values in the props destructuring", availableFrom: "0.0.0", detection: { legacy: ["function-default-props"] } },
        { id: "function-prop-types", title: "propTypes on function components", status: "ignored", replacement: "TypeScript types or runtime validation at the boundary", availableFrom: "0.0.0", detection: { legacy: ["function-prop-types"] } },
        { id: "create-factory", title: "React.createFactory", status: "removed", replacement: "JSX or createElement", availableFrom: "0.0.0", detection: { calls: [{ module: "react", names: ["createFactory"] }] } },
        { id: "test-utils-act", title: "act from react-dom/test-utils", status: "removed", replacement: "act from react", availableFrom: "18.3.0", detection: { imports: [{ module: "react-dom/test-utils" }], calls: [{ module: "react-dom/test-utils", names: ["act"] }] } },
        { id: "shallow-renderer", title: "react-test-renderer/shallow", status: "removed", replacement: "a full render with a testing library", availableFrom: "0.0.0", detection: { imports: [{ module: "react-test-renderer/shallow" }] } },
      ],
      review: ["React 19 requires the modern JSX transform; confirm the build compiles JSX with the automatic runtime"],
    },
  ],
};

export const UPGRADE_KNOWLEDGE: Readonly<Record<string, UpgradeKnowledge>> = { react: REACT_UPGRADE_KNOWLEDGE };

export function knowledgeDigest(knowledge: UpgradeKnowledge): string {
  return digestDocument(knowledge).digest;
}
