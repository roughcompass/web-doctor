# Web Doctor

Web Doctor is the local CLI and MCP surface for evidence-backed React project context and enterprise policy.

## Development

Requires Node.js 24 or newer and the internal npm registry that serves the `@repo-facts` packages. The committed `.npmrc` resolves that scope only through `REPO_FACTS_NPM_REGISTRY` and never runs dependency lifecycle scripts:

```sh
export REPO_FACTS_NPM_REGISTRY=<internal registry URL>
npm ci
npm run check
```

`npm run build` records the pinned repo-facts release in `generated/repo-facts.json`; see [Shared Repository Facts Release](docs/contracts.md#shared-repository-facts-release).

Build the package before launching the MCP server:

```sh
npm run build
WEB_DOCTOR_REGISTRY_ROOT=generated/registry node dist/mcp-entry.js
```

The override selects an assembled development registry. Published packages use their embedded `generated/registry`. MCP startup verifies and pins the complete registry before accepting requests. The stdio server reserves stdout for MCP protocol messages and writes failures to stderr.

## Contracts

See [Contract versioning and compatibility](docs/contracts.md) for the internal npm identity contract, contribution/catalog/lock boundaries, compatibility and lifecycle guarantees, published document schemas, and validated examples.

See [Contribution catalog operations](docs/registry.md) for the registry layout, internal npm configuration, ownership, lifecycle, lock regeneration, provenance, and reviewed rollback workflow.

See [Package assembly and release](docs/package-release.md) for deterministic assembly, internal npm retention, integrity verification, release provenance, reproduction, and rollback operations.

See [Federated contribution authoring](docs/federated-authoring.md) for templates, validation, internal publication, catalog proposals, platform approval, embedding, and retirement.

See [Project context](docs/project-context.md) for shared versus Web Doctor fact ownership, detector provenance, certainty states, skipped inputs, reader exclusions, budgets, and live updates.

See [Reading Web Doctor guidance](docs/guidance.md) for how responses show recommendation strength, confidence, policy provenance, project evidence, and non-modifying behavior.

See [ESLint provider](docs/eslint-provider.md) for the provider contract, configuration composition, plugin approval, suppressions, fix policy, and changed-file scope.

See [Axe provider](docs/axe-provider.md) for rendered accessibility checks, runtime requests, authenticated targets, sensitive output, and proof boundaries.

Start with the [Web Doctor overview and operator runbook](docs/overview.md) for how one package, one MCP server, policy layers, portals, and provider proof boundaries fit together.

See [Installing and operating Web Doctor](docs/operations.md) for installation, portal selection, agent registration, CI gates and exit codes, updates, offline use, rollback, and troubleshooting.

See [React Doctor provider](docs/react-doctor.md) for the approval decision, its legal and security conditions, the supported version policy, rollback, and the [fleet evaluation](docs/react-doctor-evaluation.md).

See the [Advisory pilot runbook](docs/pilot.md) for capturing pilot runs, reviewing findings, and holding the readiness review before any Control gates CI.

See [Performance budgets and fleet compatibility](docs/performance.md) for the approved budgets, service-level targets, and fleet results.

See [Runtime configuration and updates](docs/runtime-configuration.md) for multiple portals, source scope, embedded contributions, offline behavior, update status, managed upgrades, and immutable installs.

See [Repository governance](docs/repository-governance.md) for CODEOWNERS coverage and required branch-protection checks.

Platform reviewers use the [Platform Contribution Review Checklist](docs/platform-review-checklist.md) for catalog changes.