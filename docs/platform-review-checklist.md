# Platform Contribution Review Checklist

Use this checklist for every Web Doctor catalog pull request. Approval applies to the exact pull-request commit, package version, registry integrity, generated lock, and provenance shown by `Registry / validate`.

## Identity and Ownership

- Confirm the contribution ID is globally unique and remains inside the submitting team's registered namespace.
- Confirm `registry/ownership.json` names exactly one owner and the expected CODEOWNERS team.
- Confirm portal and layer applicability match the owning team's remit.
- Confirm package name, exact version, and SHA-512 integrity identify the intended internal npm artifact.

## Fixtures and Signal Quality

- Confirm every declared fixture is present and passes the approved validation harness.
- Review positive and negative fixtures for meaningful boundary coverage.
- Require false-positive evidence from representative repositories for a new or broadened rule.
- Confirm messages, remediation, and verification guidance are actionable and do not overstate proof.
- Check that suppressions or exceptions are narrow, attributable, and governed by the applicable Control.

## Dependencies and Provenance

- Review every new or changed direct and transitive contribution dependency.
- Confirm dependencies resolve to cataloged exact package versions and integrity.
- Confirm source repository and commit provenance match package metadata and the reviewed source release.
- Confirm the generated lock contains no unexpected package, registry, lifecycle, or provenance change.
- Reject alternate registries, dist-tags, ranges, aliases, Git dependencies, and missing integrity.

## Capabilities and Resource Bounds

- Grant only capabilities required by the declared provider behavior.
- Review filesystem scope, network destinations, browser use, subprocess behavior, and environment access.
- Confirm time, memory, file-count, file-size, process-count, and output limits are explicit and appropriate.
- Confirm executable artifacts run in bounded child processes and do not apply source fixes.
- Confirm package lifecycle scripts are not needed and are never run during retrieval or validation.

## Compatibility and Lifecycle

- Confirm the Web Doctor, adapter, analyzer engine, Node, framework, and runtime ranges are valid and intersect supported versions.
- Confirm portal, platform, and application applicability is bounded and explainable.
- For deprecation or retirement, require migration guidance and validate any replacement is active, type-compatible, and does not weaken required layers.
- Confirm the prior catalog revision and package remain reproducible for rollback.

## Approval

- Review the deterministic provenance diff from `Registry / validate`.
- Confirm `Registry / validate` passes on the latest pull-request commit with no generated-lock diff.
- Re-request owner or security review when capabilities, dependencies, executable artifacts, or scope materially change.
- Record the rationale for accepting residual false positives, operational cost, or compatibility trade-offs.