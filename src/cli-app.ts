import process from "node:process";
import { validatePolicyAuthoring } from "./authoring/policy.js";
import { validateProviderAuthoring } from "./authoring/provider.js";
import { packContribution } from "./authoring/contribution-package.js";
import { prepareCatalogProposal } from "./authoring/catalog-proposal.js";
import { validateRegistryFiles } from "./registry/command.js";
import { runWebDoctorStdioServer } from "./mcp.js";
import { loadBuildProvenance } from "./runtime/provenance.js";
import { WEB_DOCTOR_VERSION } from "./version.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const HELP = `Web Doctor ${WEB_DOCTOR_VERSION}

Usage: web-doctor <command>

Commands:
  mcp                 Run the local MCP server over stdio
  registry validate   Validate catalog, ownership, lock, and extracted contributions
  policy validate     Validate a policy pack, providers, and Control fixtures
  provider validate   Validate an ESLint provider contribution and fixtures
  contribution pack   Validate and deterministically pack a contribution
  contribution propose Prepare a reviewed catalog update for a published package
  provenance          Show exact package, registry, and contribution build inputs
  version             Print the installed version
  help                Show this help
`;

export async function runCli(args: readonly string[], io: CliIo = processIo()): Promise<number> {
  const [command, subcommand, ...rest] = args;

  if (command === "mcp") {
    await runWebDoctorStdioServer();
    return 0;
  }
  if (command === "registry" && subcommand === "validate") {
    return runRegistryValidate(rest, io);
  }
  if (command === "policy" && subcommand === "validate") {
    return runPolicyValidate(rest, io);
  }
  if (command === "provider" && subcommand === "validate") {
    return runProviderValidate(rest, io);
  }
  if (command === "contribution" && subcommand === "pack") {
    return runContributionPack(rest, io);
  }
  if (command === "contribution" && subcommand === "propose") {
    return runContributionProposal(rest, io);
  }
  if (command === "provenance") {
    return runProvenance([subcommand, ...rest].filter((value): value is string => value !== undefined), io);
  }
  if (command === "version" || command === "--version" || command === "-v") {
    io.stdout(`${WEB_DOCTOR_VERSION}\n`);
    return 0;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    io.stdout(HELP);
    return 0;
  }

  io.stderr(`Unknown command: ${command}\n\n${HELP}`);
  return 1;
}

async function runContributionProposal(args: readonly string[], io: CliIo): Promise<number> {
  try {
    const values = new Map<string, string>();
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--json") { json = true; continue; }
      if (!["--catalog", "--output", "--id", "--package", "--version", "--repository", "--commit", "--registry"].includes(argument)) {
        throw new Error(`Unknown option ${argument}`);
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      values.set(argument.slice(2), value);
      index += 1;
    }
    const required = (name: string): string => {
      const value = values.get(name);
      if (value === undefined) throw new Error(`--${name} is required`);
      return value;
    };
    const result = await prepareCatalogProposal({
      catalogPath: values.get("catalog") ?? "registry/catalog.json",
      outputPath: required("output"),
      contributionId: required("id"),
      packageName: required("package"),
      version: required("version"),
      repository: required("repository"),
      commit: required("commit"),
      registry: values.get("registry") ?? process.env.WEB_DOCTOR_NPM_REGISTRY ?? "",
    });
    if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else io.stdout(`Prepared ${result.outputPath} for platform review: ${result.packageName}@${result.version} ${result.integrity}\n`);
    return 0;
  } catch (error) {
    io.stderr(`Contribution proposal failed: ${messageFrom(error)}\n`);
    return 1;
  }
}

async function runContributionPack(args: readonly string[], io: CliIo): Promise<number> {
  try {
    const values = new Map<string, string>();
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--json") { json = true; continue; }
      if (!["--root", "--manifest", "--output"].includes(argument)) throw new Error(`Unknown option ${argument}`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      values.set(argument.slice(2), value);
      index += 1;
    }
    const result = await packContribution({
      root: values.get("root") ?? ".",
      manifestPath: values.get("manifest") ?? "web-doctor.json",
      outputDirectory: values.get("output") ?? "dist",
    });
    if (json) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else io.stdout(`Packed ${result.packageName}@${result.version}: ${result.filename} ${result.integrity}\n`);
    return 0;
  } catch (error) {
    io.stderr(`Contribution pack failed: ${messageFrom(error)}\n`);
    return 1;
  }
}

async function runProviderValidate(args: readonly string[], io: CliIo): Promise<number> {
  try {
    const values = new Map<string, string[]>();
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--json") { json = true; continue; }
      if (!["--manifest", "--contribution", "--plugin", "--fixture"].includes(argument)) throw new Error(`Unknown option ${argument}`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      const name = argument.slice(2);
      values.set(name, [...(values.get(name) ?? []), value]);
      index += 1;
    }
    const required = (name: string): string => {
      const entries = values.get(name) ?? [];
      if (entries.length !== 1) throw new Error(`--${name} is required exactly once`);
      return entries[0]!;
    };
    const report = await validateProviderAuthoring({
      manifestPath: required("manifest"),
      contributionPath: required("contribution"),
      pluginPath: required("plugin"),
      fixturePaths: values.get("fixture") ?? [],
    });
    if (json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else if (report.valid) io.stdout(`Provider valid: ${report.rules} rules, ${report.fixtures} fixtures\n`);
    else {
      io.stdout(`Provider invalid: ${report.issues.length} issues\n`);
      for (const issue of report.issues) io.stdout(`- ${issue.code} ${issue.path}: ${issue.message}\n`);
    }
    return report.valid ? 0 : 2;
  } catch (error) {
    io.stderr(`Provider validation failed: ${messageFrom(error)}\n`);
    return 1;
  }
}

async function runPolicyValidate(args: readonly string[], io: CliIo): Promise<number> {
  try {
    const values = new Map<string, string[]>();
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--json") { json = true; continue; }
      if (!["--policy", "--fixture", "--provider"].includes(argument)) throw new Error(`Unknown option ${argument}`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      const name = argument.slice(2);
      values.set(name, [...(values.get(name) ?? []), value]);
      index += 1;
    }
    const policyPath = values.get("policy")?.at(0);
    if (policyPath === undefined) throw new Error("--policy is required");
    if ((values.get("policy")?.length ?? 0) > 1) throw new Error("--policy may be specified only once");
    const report = await validatePolicyAuthoring({
      policyPath,
      fixturePaths: values.get("fixture") ?? [],
      providerPaths: values.get("provider") ?? [],
    });
    if (json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else if (report.valid) io.stdout(`Policy valid: ${report.fixtures} fixtures\n`);
    else {
      io.stdout(`Policy invalid: ${report.issues.length} issues\n`);
      for (const issue of report.issues) io.stdout(`- ${issue.code} ${issue.path}: ${issue.message}\n`);
    }
    return report.valid ? 0 : 2;
  } catch (error) {
    io.stderr(`Policy validation failed: ${messageFrom(error)}\n`);
    return 1;
  }
}

async function runProvenance(args: readonly string[], io: CliIo): Promise<number> {
  try {
    let snapshotPath: string | undefined;
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--json") {
        json = true;
        continue;
      }
      if (argument === "--snapshot") {
        snapshotPath = args[index + 1];
        if (snapshotPath === undefined) throw new Error("Missing value for --snapshot");
        index += 1;
        continue;
      }
      throw new Error(`Unexpected argument ${argument}`);
    }
    const provenance = await loadBuildProvenance(snapshotPath === undefined ? {} : { snapshotPath });
    if (json) io.stdout(`${JSON.stringify(provenance, null, 2)}\n`);
    else {
      io.stdout(`Web Doctor ${provenance.webDoctorVersion}\n`);
      io.stdout(`Registry ${provenance.registryDigest}\n`);
      io.stdout(`Web Doctor commit ${provenance.webDoctorCommit}\n`);
      io.stdout(`Catalog commit ${provenance.catalogCommit}\n`);
      for (const contribution of provenance.contributions) {
        io.stdout(`- ${contribution.id}: ${contribution.packageName}@${contribution.version} ${contribution.integrity}\n`);
      }
    }
    return 0;
  } catch (error) {
    io.stderr(`Provenance failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runRegistryValidate(args: readonly string[], io: CliIo): Promise<number> {
  try {
    const options = parseRegistryArguments(args);
    const report = await validateRegistryFiles(options);
    if (options.json) {
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else if (report.valid) {
      io.stdout(`Registry valid: ${report.contributions} contributions\n`);
    } else {
      io.stdout(`Registry invalid: ${report.issues.length} issues\n`);
      for (const issue of report.issues) io.stdout(`- ${issue.code} ${issue.path}: ${issue.message}\n`);
    }
    return report.valid ? 0 : 2;
  } catch (error) {
    io.stderr(`Registry validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseRegistryArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  const allowed = new Set(["catalog", "ownership", "lock", "contributions"]);
  for (const name of values.keys()) if (!allowed.has(name)) throw new Error(`Unknown option --${name}`);

  return {
    catalogPath: values.get("catalog") ?? "registry/catalog.json",
    ownershipPath: values.get("ownership") ?? "registry/ownership.json",
    lockPath: values.get("lock") ?? "registry/registry.lock.json",
    contributionsRoot: values.get("contributions") ?? "tmp/contributions",
    json,
  };
}

function processIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
