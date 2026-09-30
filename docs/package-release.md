# Package Assembly and Release

Web Doctor releases are immutable internal npm packages assembled from reviewed Git state and exact retained contribution packages. Runtime processes use only the embedded registry; they never resolve contribution packages or source repositories.

## Assembly Inputs

A release is determined by the Web Doctor package version and commit, catalog commit, and canonical contribution lock. Each contribution adds its exact npm package name, version, SHA-512 integrity, manifest digest, and Git provenance. Git provenance is evidence about the source release; only the npm coordinate and integrity select package bytes.

Release CI runs `npm ci --ignore-scripts`, the complete `npm run check`, and `npm run release:verify`. The verifier retrieves each exact contribution from `WEB_DOCTOR_NPM_REGISTRY` and verifies its integrity without running lifecycle scripts. It validates declared documents, fixtures, and runtime artifacts. It then regenerates the canonical lock, compiles the registry snapshot, and assembles `generated/registry` in temporary storage. Publication stops unless those bytes exactly match the checked-in lock and generated tree.

The package dry run must list `generated/registry/snapshot.json` and only declared contribution files:

```sh
npm pack --dry-run
```

After the gate passes, CI publishes the unchanged package through the enterprise npm channel. Never publish locally with a different registry or overwrite an existing version.

## Retention and Integrity

The internal npm registry must retain every contribution tarball selected by a supported or auditable Web Doctor revision, including deprecated and retired versions. It must also retain every published Web Doctor package. Disable version overwrite and unpublish for these packages; retention is what makes historical findings and rollback reproducible.

Inspect registry-reported package integrity before changing a catalog entry:

```sh
npm view @scope/contribution@1.2.3 dist.integrity --registry "$WEB_DOCTOR_NPM_REGISTRY"
npm pack @scope/contribution@1.2.3 --dry-run --json --ignore-scripts --registry "$WEB_DOCTOR_NPM_REGISTRY"
```

The reported SHA-512 SRI value must equal the catalog value. Package-manager lockfiles independently pin the installed Web Doctor package and its integrity. Application repositories should select an exact Web Doctor version, commit their package-manager lockfile, and use the frozen or clean-install mode appropriate to that package manager. Do not use a dist-tag or semver range as rollback evidence.

## Release Provenance

Inspect the exact inputs embedded in an installed release:

```sh
web-doctor provenance --json
```

The result includes the Web Doctor version and commit, catalog commit, registry snapshot digest, and catalog digest. It also identifies every contribution's package, integrity, manifest digest, repository, and source commit. CLI and MCP results use this same process-pinned provenance.

## Reproduce a Prior Revision

Check out the prior release commit and use its dependency lockfile, catalog, contribution lock, and generated tree:

```sh
git switch --detach <web-doctor-release-commit>
npm ci --ignore-scripts
export WEB_DOCTOR_NPM_REGISTRY=https://npm.internal.example/
export WEB_DOCTOR_COMMIT="$(git rev-parse HEAD)"
export WEB_DOCTOR_CATALOG_COMMIT="$(git log -1 --format=%H -- registry/catalog.json registry/registry.lock.json)"
npm run release:verify
```

Success proves that retained exact contribution packages reproduce the checked-in lock and embedded snapshot byte for byte. A missing tarball, integrity mismatch, changed fixture result, stale lock, or generated-file difference fails verification. Source Git checkouts are not accepted as substitutes for unavailable npm artifacts.

## Rollback Procedure

For an application-only rollback, install the previously approved exact Web Doctor version and restore the corresponding package-manager lockfile. Existing long-running processes remain pinned to their current embedded digest until restart.

For a catalog rollback, revert or follow up through a pull request. Select the retained exact contribution versions and integrity values, regenerate reviewed outputs, and obtain platform CODEOWNERS approval. Publish the change as a new Web Doctor version. Never mutate an already published contribution or Web Doctor package.