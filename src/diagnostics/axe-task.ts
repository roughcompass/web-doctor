import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { ValidatedTarget, RuntimeStep } from "./runtime-request.js";

/**
 * Runs inside a bounded provider worker granted a browser and network access.
 * Each target is loaded in a fresh browser context, brought to its state with
 * declarative steps, and checked with the approved axe rules. A failed or
 * crashed target is recorded and never stops the others. Results keep rule,
 * selector, and summary; page markup and screenshots are never captured.
 */

export interface AxeTaskInput {
  targets: ValidatedTarget[];
  rules: string[];
  axeSourcePath: string;
  timeoutMs: number;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string | null;
  tags: string[];
  nodes: { target: string[]; failureSummary: string | null }[];
}

export interface AxeTargetResult {
  target: ValidatedTarget;
  status: "tested" | "failed";
  reason: string | null;
  violations: AxeViolation[];
  /** Rules axe could not decide, which need manual review. */
  needsReview: { id: string; nodes: number }[];
}

export interface AxeTaskOutput {
  engineVersion: string;
  browserVersion: string | null;
  launchError: string | null;
  targets: AxeTargetResult[];
}

interface AxeRunResult {
  violations: { id: string; impact?: string | null; help: string; helpUrl?: string; tags: string[]; nodes: { target: unknown[]; failureSummary?: string }[] }[];
  incomplete: { id: string; nodes: unknown[] }[];
}

const SUMMARY = 300;

export async function scan(input: AxeTaskInput): Promise<AxeTaskOutput> {
  const { chromium } = await import("playwright-core");
  const axeSource = fs.readFileSync(input.axeSourcePath, "utf8");
  const engineVersion = /axe v(\d+\.\d+\.\d+)/.exec(axeSource)?.[1] ?? "unknown";
  const output: AxeTaskOutput = { engineVersion, browserVersion: null, launchError: null, targets: [] };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: input.timeoutMs });
  } catch (error) {
    output.launchError = firstLine(error);
    return output;
  }
  output.browserVersion = browser.version();
  let disconnected: string | null = null;
  browser.on("disconnected", () => {
    disconnected ??= "The browser process exited during the run";
  });

  for (const target of input.targets) {
    if (disconnected !== null) {
      output.targets.push({ target, status: "failed", reason: disconnected, violations: [], needsReview: [] });
      continue;
    }
    let context;
    let crashed = false;
    try {
      context = await browser.newContext({
        viewport: target.viewport,
        bypassCSP: true,
        serviceWorkers: "block",
        acceptDownloads: false,
        ...(target.storageState === null ? {} : { storageState: target.storageState }),
      });
      const page = await context.newPage();
      page.on("crash", () => {
        crashed = true;
      });
      page.setDefaultTimeout(input.timeoutMs);
      const response = await page.goto(target.url, { waitUntil: "load", timeout: input.timeoutMs });
      if (response !== null && response.status() >= 400) throw new Error(`The target answered HTTP ${response.status()}`);
      for (const step of target.steps) await perform(page, step, input.timeoutMs);
      await page.addScriptTag({ content: axeSource });
      const result = await page.evaluate(async (rules) => {
        const page = globalThis as unknown as { document: unknown; axe: { run(context: unknown, options: unknown): Promise<AxeRunResult> } };
        const run = await page.axe.run(page.document, { runOnly: { type: "rule", values: rules }, resultTypes: ["violations", "incomplete"] });
        return {
          violations: run.violations.map((violation) => ({ id: violation.id, impact: violation.impact ?? null, help: violation.help, helpUrl: violation.helpUrl ?? null, tags: violation.tags, nodes: violation.nodes.map((node) => ({ target: node.target.map((selector) => (Array.isArray(selector) ? selector.join(" >>> ") : String(selector))), failureSummary: node.failureSummary ?? null })) })),
          incomplete: run.incomplete.map((item) => ({ id: item.id, nodes: item.nodes.length })),
        };
      }, input.rules);
      output.targets.push({
        target,
        status: "tested",
        reason: null,
        violations: result.violations.map((violation) => ({ ...violation, nodes: violation.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary === null ? null : node.failureSummary.slice(0, SUMMARY) })) })),
        needsReview: result.incomplete.filter((item) => item.nodes > 0),
      });
    } catch (error) {
      output.targets.push({ target, status: "failed", reason: crashed ? "The page crashed while loading or checking the target" : firstLine(error), violations: [], needsReview: [] });
    } finally {
      await context?.close().catch(() => undefined);
    }
  }
  await browser.close().catch(() => undefined);
  return output;
}

async function perform(page: import("playwright-core").Page, step: RuntimeStep, timeout: number): Promise<void> {
  switch (step.action) {
    case "goto":
      await page.goto(step.url, { waitUntil: "load", timeout });
      return;
    case "click":
      await page.click(step.selector, { timeout });
      return;
    case "fill":
      await page.fill(step.selector, step.value, { timeout });
      return;
    case "press":
      await page.keyboard.press(step.key);
      return;
    case "waitFor":
      await page.waitForSelector(step.selector, { timeout });
      return;
  }
}

function firstLine(error: unknown): string {
  return stripVTControlCharacters((error instanceof Error ? error.message : String(error)).split("\n")[0]!).slice(0, 300);
}
