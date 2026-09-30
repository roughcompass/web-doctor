# Web Runtime Governance Example

This example is one npm contribution owned by the Web Runtime Platform team. It contains six ESLint rules, five policy Controls, twelve executable fixtures, and one catalog identity. A production package can add hundreds of runtime rules by extending the same provider and policy manifests.

The package enforces these runtime conventions:

- Runtime integration events use `runtimeApi.eventHub.publish`, not global `window` events.
- `localStorage` keys use `portal:application:key` namespacing to prevent collisions on a shared origin.
- React 16 retirement is a recommended migration. The static rule finds legacy root APIs; repo-facts verifies the installed React version.
- Content Gateway and Jules configuration are deprecated in favor of CDaaS managed hosting.
- Local web harnesses produce a warning because they can diverge from the managed runtime development environment.

Package contents:

```text
web-doctor.json  contribution identity, files, provenance, and fixtures
provider.json    executable six-rule catalog
policy.json      five Controls that select those rules
plugin.mjs       all rule implementations
fixtures/        deterministic pass and fail cases
```

The provider fixtures make each detector independently reviewable. Policy strength controls product behavior: required Controls may gate CI, while the React migration, CDaaS migration, and local harness Controls are currently recommended warnings.

Validate every rule and fixture:

```sh
node dist/cli.js provider validate \
  --manifest examples/web-runtime-governance/provider.json \
  --contribution examples/web-runtime-governance/web-doctor.json \
  --plugin examples/web-runtime-governance/plugin.mjs \
  --fixture examples/web-runtime-governance/fixtures/event-hub-pass.json \
  --fixture examples/web-runtime-governance/fixtures/event-hub-fail.json \
  --fixture examples/web-runtime-governance/fixtures/storage-pass.json \
  --fixture examples/web-runtime-governance/fixtures/storage-fail.json \
  --fixture examples/web-runtime-governance/fixtures/react-root-pass.json \
  --fixture examples/web-runtime-governance/fixtures/react-root-fail.json \
  --fixture examples/web-runtime-governance/fixtures/content-gateway-pass.json \
  --fixture examples/web-runtime-governance/fixtures/content-gateway-fail.json \
  --fixture examples/web-runtime-governance/fixtures/jules-config-pass.json \
  --fixture examples/web-runtime-governance/fixtures/jules-config-fail.json \
  --fixture examples/web-runtime-governance/fixtures/local-harness-pass.json \
  --fixture examples/web-runtime-governance/fixtures/local-harness-fail.json \
  --json
```

Validate all policy references against the provider manifest:

```sh
node dist/cli.js policy validate \
  --policy examples/web-runtime-governance/policy.json \
  --provider examples/web-runtime-governance/provider.json \
  --json
```

Before release, CI packs and publishes this directory once. The Web Doctor catalog pins one exact npm version, SHA-512 integrity, and source commit for the complete runtime governance release.