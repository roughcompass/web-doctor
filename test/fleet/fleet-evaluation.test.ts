import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { representativePolicyPacks } from "../fixtures/policies.js";
import { installManagedApplication, type CleanInstallation } from "../support/clean-install.js";

/**
 * Runs every project-context stage independently against the fleet from a
 * managed installation under its Node 24 runtime, and compares each
 * repository's outcome with the recorded expectations. Set
 * WEB_DOCTOR_WRITE_EVIDENCE=1 to record a new evaluation and expectations.
 */

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const FLEET = process.env.WEB_DOCTOR_FLEET_ROOT ?? path.resolve(ROOT, "../fleet");
const EXPECTATIONS = path.join(ROOT, "evidence", "fleet-expectations.json");

interface StageResult { status: string; durationMs: number; error?: string; [key: string]: unknown }
interface RepositoryResult { repository: string; reader: StageResult; bundle: StageResult; index: StageResult; policy: StageResult; processes: unknown[]; treeUnchanged: boolean }
interface Evaluation { installation: string; node: string; repositories: RepositoryResult[]; networkAttempts: string[]; registryDigest: string }

/** The outcome fields a regression would change; durations are measured separately against budgets. */
function expectation(result: RepositoryResult) {
  return {
    reader: { status: result.reader.status, exclusions: result.reader.exclusions },
    bundle: { status: result.bundle.status, incompleteCategories: result.bundle.incompleteCategories, skippedInputs: result.bundle.skippedInputs, packageManagers: result.bundle.packageManagers, frameworks: result.bundle.frameworks },
    index: { status: result.index.status, modules: result.index.modules, components: result.index.components, hooks: result.index.hooks, skipped: result.index.skipped },
    policy: { status: result.policy.status, factStatus: result.policy.factStatus, controls: result.policy.controls, unresolvedApplicability: result.policy.unresolvedApplicability },
  };
}

describe.runIf(fs.existsSync(FLEET))("fleet evaluation under the managed Node 24 runtime", () => {
  let installation: CleanInstallation & { managedRoot: string };
  let evaluation: Evaluation;

  beforeAll(async () => {
    installation = await installManagedApplication({ files: { "package.json": "{}\n" }, policies: representativePolicyPacks });
    const packageRoot = path.dirname(path.dirname(installation.command.at(-1)!));
    const out = path.join(installation.workspace, "fleet-evaluation.json");
    await execFileAsync(installation.command[0]!, [path.join(ROOT, "scripts", "evaluate-fleet.mjs"), "--package", packageRoot, "--registry", path.join(packageRoot, "generated", "registry"), "--out", out, FLEET], { env: installation.env, maxBuffer: 64 * 1024 * 1024 });
    evaluation = JSON.parse(fs.readFileSync(out, "utf8")) as Evaluation;
    if (process.env.WEB_DOCTOR_WRITE_EVIDENCE === "1") {
      fs.writeFileSync(path.join(ROOT, "evidence", "fleet-evaluation.json"), `${JSON.stringify(evaluation, null, 2)}\n`);
      fs.writeFileSync(EXPECTATIONS, `${JSON.stringify(Object.fromEntries(evaluation.repositories.map((result) => [result.repository, expectation(result)])), null, 2)}\n`);
    }
  }, 600_000);

  afterAll(async () => {
    await installation?.close();
  });

  it("runs from the managed installation on Node 24 against all eight repositories", () => {
    expect(evaluation.installation).toBe("managed");
    expect(Number(evaluation.node.slice(1).split(".")[0])).toBe(24);
    expect(evaluation.repositories.map((result) => result.repository)).toEqual(["acme-platform", "legacy-portal", "mf-admin", "mf-billing", "mf-shell", "spa-orders", "spa-reports", "spa-root"]);
  });

  it("completes each stage or reports an explicit, named incomplete condition", () => {
    for (const result of evaluation.repositories) {
      for (const [name, stage] of Object.entries({ reader: result.reader, bundle: result.bundle, index: result.index, policy: result.policy })) {
        expect(stage.status, `${result.repository} ${name}: ${stage.error ?? ""}`).not.toBe("failed");
        if (stage.status === "incomplete") {
          const named = [stage.incompleteCategories, stage.skipped, stage.unresolvedApplicability, stage.problems].some((list) => Array.isArray(list) && list.length > 0);
          expect(named, `${result.repository} ${name} is incomplete without saying why`).toBe(true);
        }
      }
    }
  });

  it("records both the shared fact provenance and the policy provenance for every repository", () => {
    for (const result of evaluation.repositories) {
      expect(result.bundle, result.repository).toMatchObject({ detectorRelease: "0.1.0", configurationDigest: expect.stringMatching(/^[0-9a-f]{64}$/), factDocumentDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(result.policy, result.repository).toMatchObject({ policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/), registryDigest: evaluation.registryDigest, extensionStateDigest: expect.stringMatching(/^[0-9a-f]{64}$/), factStatus: "complete" });
    }
  });

  it("runs no repository script, makes no network connection, and changes no repository", () => {
    expect(evaluation.networkAttempts).toEqual([]);
    for (const result of evaluation.repositories) {
      expect(result.processes, result.repository).toEqual([]);
      expect(result.treeUnchanged, result.repository).toBe(true);
    }
  });

  it("matches the recorded outcome for every repository", () => {
    const expected = JSON.parse(fs.readFileSync(EXPECTATIONS, "utf8")) as Record<string, ReturnType<typeof expectation>>;
    for (const result of evaluation.repositories) expect(expectation(result), result.repository).toEqual(expected[result.repository]);
  });
});
