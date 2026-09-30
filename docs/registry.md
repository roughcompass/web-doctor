# Contribution Catalog Operations

The Web Doctor repository is the reviewed GitOps registry for enterprise web contributions. Contribution teams publish exact packages to the internal npm registry; catalog pull requests select those immutable artifacts for the next Web Doctor release.

## Repository Layout

- `registry/catalog.json` selects contribution package name, exact version, SHA-512 registry integrity, owner, lifecycle, compatibility, portals, layers, dependencies, and source provenance.
- `registry/ownership.json` maps contribution namespaces and portals to one owning team and records the platform review team.
- `.github/CODEOWNERS` protects the entire `registry/` path with the platform review team.
- `registry.lock.json` is generated from the catalog after package manifests are retrieved and verified. It is never edited manually.

## Internal npm Configuration

Registry URLs and credentials are environment or CI configuration, never catalog data. Catalog sources use the literal registry class `internal`, an npm package name, exact version, and SHA-512 SRI value. Dist-tags, semver ranges, aliases, Git dependencies, alternate registries, and missing integrity are invalid.

Resolvers must retrieve the selected tarball with lifecycle scripts disabled and verify integrity before reading any declared package path. Credentials must use the existing enterprise npm credential mechanism and must not be written into catalog, lock, fixture, or report files.

## Local Checks

Run every registry-focused test:

```sh
npm run registry:check
```

Generate a canonical lock from the checked-in catalog and local package-registry metadata fixture:

```sh
npm run registry:lock:fixture
```

The fixture command builds Web Doctor and writes `tmp/registry.lock.json`. Production pull-request validation uses retrieved, integrity-verified contribution manifests instead of fixture metadata.

## Ownership and Review

Every catalog entry references one owner ID. That owner must cover the contribution namespace in `registry/ownership.json`. Every portal must likewise map to exactly one owner. The platform CODEOWNERS team reviews all catalog, ownership, and generated-lock changes; author-team publication alone cannot register a contribution.

Changing a package version, integrity value, dependency, lifecycle, owner, compatibility range, portal, layer, or source provenance invalidates prior CI and review. The generated lock diff is part of the pull request.

## Lifecycle

Active contributions participate in new snapshots. Deprecated contributions remain available with migration guidance and may identify an active replacement. Retired contributions do not enter new effective policy. A replacement must exist, remain active, and preserve every layer of the contribution it replaces.

Portal lifecycle follows the same reviewed pattern. Active contributions cannot target a deprecated or retired portal. Retired or deprecated portals may identify an active replacement.

## Lock and Provenance

Lock generation normalizes catalog entry, portal, layer, and dependency ordering. It records exact package versions, registry integrity, manifest contract versions and digests, transitive contribution dependencies, and source repository/commit provenance. Semantically identical inputs produce byte-identical canonical lock files.

The npm coordinate and integrity select package bytes. Git repository and commit are audit provenance only. Web Doctor never substitutes source checkout contents for a missing package artifact.

## Reviewed Rollback

Rollback is a normal catalog revert or follow-up pull request selecting a previously retained exact package version and integrity. Regenerate the lock, run registry checks, obtain fresh platform approval, merge, and publish a new Web Doctor package. Never mutate an already published Web Doctor or contribution package.