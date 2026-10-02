import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { mcpResponseSchema, type McpResponse } from "../../src/contracts/index.js";
import { generateGuidanceExamples } from "../support/guidance-examples.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DOC = path.join(ROOT, "docs/guidance.md");
const EXAMPLES = path.join(ROOT, "examples/guidance-responses");
let committed: Record<string, McpResponse>;
let generated: Record<string, McpResponse>;

beforeAll(async () => {
  generated = await generateGuidanceExamples();
  // Set UPDATE_EXAMPLES=1 to rewrite the committed examples from the current code.
  if (process.env.UPDATE_EXAMPLES === "1") {
    for (const [name, response] of Object.entries(generated)) await fs.writeFile(path.join(EXAMPLES, name), `${JSON.stringify(response, null, 2)}\n`);
  }
  committed = Object.fromEntries(await Promise.all(Object.keys(generated).map(async (name) => [name, JSON.parse(await fs.readFile(path.join(EXAMPLES, name), "utf8")) as McpResponse] as const)));
}, 120_000);

describe("guidance documentation", () => {
  it("links every response example, and every example conforms to the MCP response schema", async () => {
    const text = await fs.readFile(DOC, "utf8");
    const linked = [...text.matchAll(/\]\(\.\.\/examples\/guidance-responses\/([a-z-]+\.json)\)/g)].map((match) => match[1]).sort();
    expect(linked).toEqual(Object.keys(committed).sort());
    for (const [name, response] of Object.entries(committed)) {
      expect(mcpResponseSchema.parse(response), name).toEqual(response);
      expect(text, name).toContain(`\`${response.tool}\``);
    }
  });

  it("keeps the committed examples identical to what the current code returns", () => {
    for (const name of Object.keys(generated)) expect(committed[name], `${name} is stale; rerun with UPDATE_EXAMPLES=1`).toEqual(generated[name]);
  });

  it("shows strength, confidence, policy provenance, project evidence, and non-modifying behavior where the guide says", () => {
    const finding = committed["explain-finding.json"]!;
    const data = finding.data as {
      finding: { certainty: string; fix: { applied: boolean }; policyDigest: string; obligations: { layer: string; policy: string; contribution: string; strength: string }[] };
      recommendation: { status: string; policyDigest: string; approved: { mandatory: boolean; sources: { layer: string; control: string; strength: string; policy: string }[] }[] };
      verification: { items: { status: string }[] };
      modifiesProject: boolean;
    };
    expect(data.recommendation.approved[0]).toMatchObject({ mandatory: true, sources: [{ layer: "portal", control: "wealth/design/dialog", strength: "required", policy: "wealth/design" }] });
    expect(data.recommendation.status).toBe("approved");
    expect(["observed", "inferred", "unknown", "conflicting"]).toContain(data.finding.certainty);
    expect(data.finding.fix.applied).toBe(false);
    expect(data.finding.policyDigest).toBe(finding.provenance.policy!.digest);
    expect(data.recommendation.policyDigest).toBe(finding.provenance.policy!.digest);
    for (const obligation of data.finding.obligations) expect(obligation).toMatchObject({ layer: expect.any(String), policy: expect.any(String), contribution: expect.any(String), strength: expect.any(String) });
    for (const item of data.verification.items) expect(["satisfied", "failed", "remaining"]).toContain(item.status);

    const upgrade = committed["plan-upgrade.json"]!;
    const plan = upgrade.data as { provenance: { factDocumentDigest: string; extensionStateDigest: string }; current: { evidence: { source: string; category: string } }; stages: { changes: { occurrences: unknown[] }[]; verification: { evidence: { source: string; category: string } | null }[] }[]; manual: string[] };
    expect(plan.provenance.factDocumentDigest).toBe(upgrade.provenance.repoFacts.factDocumentDigest);
    expect(plan.provenance.extensionStateDigest).toBe(upgrade.provenance.extensions!.stateDigest);
    expect(plan.current.evidence).toMatchObject({ source: "shared", category: "resolved_dependencies" });
    expect(plan.stages.flatMap((stage) => stage.verification).filter((step) => step.evidence !== null).map((step) => step.evidence!.category)).toEqual(expect.arrayContaining(["resolved_dependencies", "verification_commands"]));
    expect(plan.stages.flatMap((stage) => stage.changes).some((change) => change.occurrences.length > 0)).toBe(true);
    expect(plan.manual.length).toBeGreaterThan(0);
    expect(upgrade.evidence.length).toBeGreaterThan(0);

    const guidance = committed["effective-guidance.json"]!.data as { patterns: { patterns: { mandatory: boolean; sources: unknown[] }[] } };
    expect(guidance.patterns.patterns[0]).toMatchObject({ mandatory: true, sources: [expect.objectContaining({ control: "wealth/design/dialog" })] });

    expect(committed["plan-verification.json"]!.complete).toBe(false);
    for (const response of Object.values(committed)) {
      const body = response.data as { modifiesProject?: boolean; patterns?: { modifiesProject: boolean } };
      expect(body.modifiesProject ?? body.patterns?.modifiesProject, response.tool).toBe(false);
    }
  });
});
