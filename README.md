# Web Doctor

Web Doctor is the local CLI and MCP surface for evidence-backed React project context and enterprise policy.

## Development

Requires Node.js 24 or newer.

```sh
npm ci
npm run check
```

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

See [Runtime configuration and updates](docs/runtime-configuration.md) for multiple portals, source scope, embedded contributions, offline behavior, update status, managed upgrades, and immutable installs.

See [Repository governance](docs/repository-governance.md) for CODEOWNERS coverage and required branch-protection checks.

Platform reviewers use the [Platform Contribution Review Checklist](docs/platform-review-checklist.md) for catalog changes.