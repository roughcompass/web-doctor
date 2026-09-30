# Contract Versioning and Compatibility

Web Doctor documents carry a `schema` name and positive integer `schemaVersion`. Consumers must select a parser by document kind and reject an unknown version before using any other field. The public `parseContract` API returns an `UnsupportedSchemaVersionError` with the received and supported versions.

The version changes whenever a schema adds, removes, renames, or changes the meaning of a field. Version 1 schemas are strict, so undeclared fields are rejected instead of being silently discarded. Catalog entries and locks identify internal npm contributions by exact version and SHA-512 registry integrity; Git repository and commit remain audit provenance.

Documents serialize through canonical JSON before digesting or signing. Object keys are lexicographically sorted, array order remains meaningful, numbers are safe integers, and only plain JSON values are accepted. Stable document identifiers use the full SHA-256 digest.

Published contribution packages remain immutable. A producer publishes a new exact package version and, when a document contract changes incompatibly, a new schema version. Readers may support several schema versions during a migration but must never reinterpret an older version using a newer schema.

## Contract Layers

The contracts form three boundaries:

1. Contribution packages publish a contribution manifest plus policy, provider, or guidance documents and declared fixtures.
2. The Web Doctor repository catalogs exact internal npm artifacts, and CI generates a deterministic contribution lock.
3. A Web Doctor release embeds a normalized registry snapshot; effective policies, findings, and MCP responses record that snapshot's digest.

Application repositories consume only Web Doctor. They do not resolve contribution packages, catalog revisions, or contribution locks directly.

## Exact Package Identity

An internal npm source is identified by all of these fields:

- the literal registry class `internal`
- a valid npm package name
- an exact npm version
- SHA-512 registry integrity in SRI form
- source repository and commit provenance

Dist-tags, semver ranges, aliases, Git dependencies, alternate registries, missing integrity, and non-SHA-512 integrity are invalid. The npm package coordinate and integrity select bytes. Git provenance explains where those bytes came from but never substitutes for the published artifact.

Contribution package paths are normalized relative POSIX paths. Absolute paths, backslashes, empty segments, `.` segments, and `..` segments are rejected. Provider runtime artifacts use package-relative paths and SHA-256 content digests.

## Catalog, Lock, and Snapshot Guarantees

Catalog changes are ordinary reviewed Git changes. A generated contribution lock resolves every accepted contribution and transitive contribution dependency to an exact internal npm version and integrity. The lock also records contract versions, lifecycle, compatibility, manifest digests, and source provenance.

Given the same catalog and retained package tarballs, lock and snapshot generation must be byte deterministic. A Web Doctor package embeds the resulting snapshot and approved runtime contents. Runtime context and policy resolution use only that embedded snapshot and do not fetch contribution packages or source repositories.

Every effective policy records the Web Doctor version, registry digest, contribution package coordinates, integrity, and provenance. Findings retain the effective-policy and registry digests. MCP responses identify the registry digest used for their result.

## Compatibility Rules

`compatibility.webDoctor` states the supported Web Doctor engine range for a contribution. Provider manifests additionally declare the provider adapter and engine ranges they require. Catalog and release validation must reject combinations with no supported engine intersection.

Package versions and schema versions are independent. A compatible contribution update publishes a new package version while retaining the existing document schema version. A breaking document-shape or semantic change publishes both a new package version and a new positive integer `schemaVersion`.

Unknown schema versions fail before structural validation. Optional fields may be added only through a new schema version because current schemas are strict. Producers must not use undeclared fields as an extension mechanism.

## Lifecycle and Migration

Catalog entries are active, deprecated, or retired. Deprecation keeps a contribution available while naming migration guidance; retirement removes it from new effective policy and may identify a replacement. Historical Web Doctor packages retain their embedded snapshot, so an old finding remains explainable even after catalog lifecycle changes.

Rollback installs or republishes a prior Web Doctor package. Reverting a catalog entry creates a new reviewed catalog revision and package release rather than mutating an already published package.

## Validation and Offline Behavior

Catalog and release CI retrieve exact tarballs from the configured internal npm registry, verify registry integrity before reading contents, and never run package lifecycle scripts. Declared fixtures execute only through the approved validation harness. Failure to retrieve, verify, parse, or validate any locked contribution prevents publication; CI must not substitute a newer or alternate artifact.

Once installed, Web Doctor's contract and policy surfaces work offline from the embedded snapshot. An optional package-update check is separate from contribution resolution and cannot change rules inside a running process.

## Published Schemas

| Document | Schema | Current version | Validated example |
|---|---|---:|---|
| Internal npm source | `web-doctor.npm-source` | 1 | [`examples/contracts/npm-source.json`](../examples/contracts/npm-source.json) |
| Contribution | `web-doctor.contribution` | 1 | [`examples/contracts/contribution.json`](../examples/contracts/contribution.json) |
| Contribution fixture | `web-doctor.fixture` | 1 | [`examples/contracts/contribution-fixture.json`](../examples/contracts/contribution-fixture.json) |
| Policy pack | `web-doctor.policy-pack` | 1 | [`examples/contracts/policy-pack.json`](../examples/contracts/policy-pack.json) |
| Provider manifest | `web-doctor.provider-manifest` | 1 | [`examples/contracts/provider-manifest.json`](../examples/contracts/provider-manifest.json) |
| Catalog | `web-doctor.catalog` | 1 | [`examples/contracts/catalog.json`](../examples/contracts/catalog.json) |
| Registry ownership | `web-doctor.registry-ownership` | 1 | [`examples/contracts/registry-ownership.json`](../examples/contracts/registry-ownership.json) |
| Contribution lock | `web-doctor.contribution-lock` | 1 | [`examples/contracts/contribution-lock.json`](../examples/contracts/contribution-lock.json) |
| Registry snapshot | `web-doctor.registry-snapshot` | 1 | [`examples/contracts/registry-snapshot.json`](../examples/contracts/registry-snapshot.json) |
| Effective policy | `web-doctor.effective-policy` | 1 | [`examples/contracts/effective-policy.json`](../examples/contracts/effective-policy.json) |
| Normalized finding | `web-doctor.finding` | 1 | [`examples/contracts/finding.json`](../examples/contracts/finding.json) |
| Guidance entry | `web-doctor.guidance-entry` | 1 | [`examples/contracts/guidance-entry.json`](../examples/contracts/guidance-entry.json) |
| MCP response | `web-doctor.mcp-response` | 1 | [`examples/contracts/mcp-response.json`](../examples/contracts/mcp-response.json) |

The source schemas, inferred TypeScript types, canonical JSON utilities, and version-aware parser are exported from the package root.