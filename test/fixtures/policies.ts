import type { PolicyPack } from "../../src/contracts/index.js";

const compatibility = { webDoctor: ">=0.1.0" };
const focusedTest = [{ kind: "test", description: "Run the focused policy verification." }];

export const firmwideAccessibilityPolicy = {
  schema: "web-doctor.policy-pack",
  schemaVersion: 1,
  id: "firm/accessibility",
  version: "1.0.0",
  owner: "Enterprise Accessibility",
  layer: "firmwide",
  compatibility,
  controls: [
    {
      id: "firm/accessibility/button-name",
      title: "Buttons have accessible names",
      rationale: "Every interactive control needs an accessible name.",
      strength: "required",
      applicability: {},
      evidence: [{ provider: "axe", rule: "button-name", kind: "rendered", required: true }],
      remediation: "Provide a visible or programmatic accessible name.",
      verification: [
        { kind: "axe", description: "Run axe against each rendered interaction state." },
        { kind: "manual", description: "Confirm the control name with a screen reader." },
      ],
      exceptionPolicy: "Requires Enterprise Accessibility approval.",
    },
  ],
} as const satisfies PolicyPack;

export const wealthBrandPolicy = {
  schema: "web-doctor.policy-pack",
  schemaVersion: 1,
  id: "wealth/brand",
  version: "2.1.0",
  owner: "Wealth Design Platform",
  layer: "portal",
  compatibility,
  controls: [
    {
      id: "wealth/brand/approved-button",
      title: "Wealth surfaces use the approved button",
      rationale: "Portal surfaces must present consistent Wealth interactions.",
      strength: "required",
      applicability: {
        portals: { anyOf: ["wealth"] },
        files: { include: ["src/wealth/**"] },
      },
      evidence: [
        { provider: "eslint", rule: "wealth-design/use-approved-button", kind: "static", required: true },
      ],
      remediation: "Use the approved Wealth design-system button.",
      verification: focusedTest,
    },
  ],
} as const satisfies PolicyPack;

export const advisorContentPolicy = {
  schema: "web-doctor.policy-pack",
  schemaVersion: 1,
  id: "advisor/content",
  version: "1.4.0",
  owner: "Advisor Experience",
  layer: "portal",
  compatibility,
  controls: [
    {
      id: "advisor/content/action-name",
      title: "Advisor actions use specific names",
      rationale: "Action names must be understandable without surrounding context.",
      strength: "required",
      applicability: { portals: { anyOf: ["advisor"] } },
      evidence: [
        { provider: "axe", rule: "button-name", kind: "rendered", required: true },
        { provider: "eslint", rule: "advisor-content/specific-action-name", kind: "static", required: true },
      ],
      remediation: "Use the approved Advisor action terminology.",
      verification: focusedTest,
    },
  ],
} as const satisfies PolicyPack;

export const platformRuntimePolicy = {
  schema: "web-doctor.policy-pack",
  schemaVersion: 1,
  id: "platform/runtime",
  version: "3.0.0",
  owner: "Web Platform",
  layer: "platform",
  compatibility,
  controls: [
    {
      id: "platform/runtime/analytics-event",
      title: "User actions use the platform analytics API",
      rationale: "The runtime contract supplies consistent session and application identity.",
      strength: "required",
      applicability: { capabilities: [{ name: "react" }] },
      evidence: [
        { provider: "eslint", rule: "platform-runtime/approved-analytics", kind: "static", required: true },
      ],
      remediation: "Emit the event through the approved platform analytics wrapper.",
      verification: focusedTest,
    },
  ],
} as const satisfies PolicyPack;

export const applicationEngineeringPolicy = {
  schema: "web-doctor.policy-pack",
  schemaVersion: 1,
  id: "application/engineering",
  version: "1.0.0",
  owner: "Application Team",
  layer: "application",
  compatibility,
  controls: [
    {
      id: "application/engineering/account-term",
      title: "Account terminology is consistent",
      rationale: "This application uses one product term for the same concept.",
      strength: "recommended",
      applicability: { files: { include: ["src/**"], exclude: ["src/generated/**"] } },
      evidence: [
        { provider: "eslint", rule: "application-content/account-term", kind: "static", required: true },
      ],
      remediation: "Use the application glossary term.",
      verification: focusedTest,
    },
  ],
} as const satisfies PolicyPack;

export const representativePolicyPacks: readonly PolicyPack[] = [
  firmwideAccessibilityPolicy,
  wealthBrandPolicy,
  advisorContentPolicy,
  platformRuntimePolicy,
  applicationEngineeringPolicy,
];