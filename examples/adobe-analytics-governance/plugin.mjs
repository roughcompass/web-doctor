const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/;
const SENSITIVE_FIELDS = new Set([
  "email",
  "emailAddress",
  "firstName",
  "lastName",
  "phone",
  "phoneNumber",
  "ssn",
]);

function isAnalyticsTrack(node) {
  return node.callee.type === "MemberExpression"
    && !node.callee.computed
    && node.callee.object.type === "Identifier"
    && node.callee.object.name === "analytics"
    && node.callee.property.type === "Identifier"
    && node.callee.property.name === "track";
}

function propertyName(property) {
  if (property.type !== "Property") return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  return typeof property.key.value === "string" ? property.key.value : undefined;
}

function sensitiveProperties(value, matches = []) {
  if (value?.type === "ObjectExpression") {
    for (const property of value.properties) {
      const name = propertyName(property);
      if (name !== undefined && SENSITIVE_FIELDS.has(name)) matches.push(property);
      if (property.type === "Property") sensitiveProperties(property.value, matches);
    }
  } else if (value?.type === "ArrayExpression") {
    for (const element of value.elements) sensitiveProperties(element, matches);
  }
  return matches;
}

export default {
  rules: {
    "no-direct-alloy-send-event": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          direct: "Send Adobe Analytics events through the enterprise analytics adapter instead of calling alloy('sendEvent') directly.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const command = node.arguments[0];
            if (node.callee.type !== "Identifier" || node.callee.name !== "alloy") return;
            if (command?.type !== "Literal" || command.value !== "sendEvent") return;
            context.report({ node, messageId: "direct" });
          },
        };
      },
    },
    "require-canonical-event-name": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          canonical: "Use a registered event name such as 'commerce.checkout.started'.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isAnalyticsTrack(node)) return;
            const eventName = node.arguments[0];
            if (eventName?.type === "Literal" && typeof eventName.value === "string" && EVENT_NAME.test(eventName.value)) return;
            context.report({ node: eventName ?? node, messageId: "canonical" });
          },
        };
      },
    },
    "no-direct-identifiers": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          sensitive: "Do not send direct identifier '{{field}}' in an analytics payload.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isAnalyticsTrack(node)) return;
            for (const property of sensitiveProperties(node.arguments[1])) {
              context.report({ node: property, messageId: "sensitive", data: { field: propertyName(property) } });
            }
          },
        };
      },
    },
  },
};