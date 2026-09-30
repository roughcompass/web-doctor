import fs from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = fs.readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

describe("release workflow", () => {
  it("gates enterprise publication on checks and deterministic artifact verification", () => {
    const check = workflow.indexOf("npm run check");
    const verify = workflow.indexOf("npm run release:verify");
    const publish = workflow.indexOf("npm publish --registry");

    expect(check).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(check);
    expect(publish).toBeGreaterThan(verify);
    expect(workflow).toContain("npm ci --ignore-scripts");
    expect(workflow).toContain("WEB_DOCTOR_NPM_REGISTRY");
    expect(workflow).toContain("WEB_DOCTOR_NPM_TOKEN");
  });
});