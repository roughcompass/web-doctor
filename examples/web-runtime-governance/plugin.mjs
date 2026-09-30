const CONTENT_GATEWAY_PATTERN = /(?:^|[/_-])content[-_]?gateway(?:$|[/_-])/i;
const JULES_PATTERN = /(?:^|[/_-])jules(?:$|[/_-])/i;
const WEB_HARNESS_PATTERN = /(?:^|[/_-])web[-_]?harness(?:$|[/_-])/i;

function memberName(node) {
  if (node?.type !== "MemberExpression") return undefined;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : undefined;
}

function isGlobalMemberCall(node, objectName, methodName) {
  return node.callee.type === "MemberExpression"
    && node.callee.object.type === "Identifier"
    && node.callee.object.name === objectName
    && memberName(node.callee) === methodName;
}

function propertyName(property) {
  if (property.type !== "Property") return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  return typeof property.key.value === "string" ? property.key.value : undefined;
}

function isNamespacedStorageKey(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:.+$/i.test(node.value);
  }
  if (node?.type !== "TemplateLiteral" || node.expressions.length < 2) return false;
  const [portal, application] = node.expressions;
  const firstSeparator = node.quasis[1]?.value.raw.startsWith(":") ?? false;
  const secondSeparator = node.quasis[2]?.value.raw.startsWith(":") ?? false;
  return portal?.type === "Identifier"
    && /portalId$/i.test(portal.name)
    && application?.type === "Identifier"
    && /applicationId$/i.test(application.name)
    && firstSeparator
    && secondSeparator;
}

export default {
  rules: {
    "use-event-hub": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          windowEvent: "Publish runtime events through runtimeApi.eventHub instead of window.{{method}}().",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            for (const method of ["dispatchEvent", "postMessage"]) {
              if (isGlobalMemberCall(node, "window", method)) {
                context.report({ node, messageId: "windowEvent", data: { method } });
              }
            }
          },
        };
      },
    },
    "require-storage-namespace": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          namespace: "Prefix localStorage keys with portal and application identifiers: portal:application:key.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isGlobalMemberCall(node, "localStorage", "setItem")) return;
            const key = node.arguments[0];
            if (isNamespacedStorageKey(key)) return;
            context.report({ node: key ?? node, messageId: "namespace" });
          },
        };
      },
    },
    "no-legacy-react-root": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          legacy: "Migrate the legacy ReactDOM.{{method}} root to createRoot or hydrateRoot before React 16 support is removed.",
        },
      },
      create(context) {
        const reactDomBindings = new Set();
        const legacyFunctions = new Map();
        return {
          ImportDeclaration(node) {
            if (node.source.value !== "react-dom") return;
            for (const specifier of node.specifiers) {
              if (specifier.type === "ImportDefaultSpecifier" || specifier.type === "ImportNamespaceSpecifier") {
                reactDomBindings.add(specifier.local.name);
              } else if (specifier.type === "ImportSpecifier") {
                const imported = specifier.imported.name ?? specifier.imported.value;
                if (imported === "render" || imported === "hydrate") legacyFunctions.set(specifier.local.name, imported);
              }
            }
          },
          CallExpression(node) {
            if (node.callee.type === "Identifier" && legacyFunctions.has(node.callee.name)) {
              context.report({ node, messageId: "legacy", data: { method: legacyFunctions.get(node.callee.name) } });
              return;
            }
            if (node.callee.type !== "MemberExpression" || node.callee.object.type !== "Identifier") return;
            const method = memberName(node.callee);
            if (!reactDomBindings.has(node.callee.object.name) || (method !== "render" && method !== "hydrate")) return;
            context.report({ node, messageId: "legacy", data: { method } });
          },
        };
      },
    },
    "no-content-gateway": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          gateway: "Content Gateway is deprecated. Move this application to CDaaS managed hosting.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (typeof node.source.value === "string" && CONTENT_GATEWAY_PATTERN.test(node.source.value)) {
              context.report({ node, messageId: "gateway" });
            }
          },
        };
      },
    },
    "no-jules-config": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          jules: "Remove Jules configuration; CDaaS managed hosting owns deployment configuration.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (typeof node.source.value === "string" && JULES_PATTERN.test(node.source.value)) {
              context.report({ node, messageId: "jules" });
            }
          },
          Property(node) {
            if (propertyName(node)?.toLowerCase() === "jules") context.report({ node, messageId: "jules" });
          },
        };
      },
    },
    "no-local-web-harness": {
      meta: {
        type: "suggestion",
        schema: [],
        messages: {
          harness: "Do not add a local web harness for runtime development; use the supported runtime development environment.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (typeof node.source.value === "string" && WEB_HARNESS_PATTERN.test(node.source.value)) {
              context.report({ node, messageId: "harness" });
            }
          },
          CallExpression(node) {
            if (node.callee.type === "Identifier" && node.callee.name === "createLocalWebHarness") {
              context.report({ node, messageId: "harness" });
            }
          },
        };
      },
    },
  },
};