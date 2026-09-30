# Runtime Configuration and Updates

Each Web Doctor process verifies and pins the package-embedded registry before serving CLI or MCP requests. Project context and policy resolution then run offline. Package update discovery is optional and cannot replace the registry inside a running process.

## Portal Selection

Supply every portal that governs the application. Repeated portal values are harmless because selection deduplicates and sorts the final set. This example selects Wealth and Advisor:

```text
--portal wealth --portal advisor --portal wealth
```

CLI or MCP arguments, repository configuration, and an optional embedded repository assignment may provide portal sets. Every non-empty source must resolve to the same set. Differing sets produce a conflict instead of applying hidden precedence. [`examples/runtime/multiple-portals.json`](../examples/runtime/multiple-portals.json) shows matching sources and their normalized result.

A required portal that is missing or inactive produces an incomplete warning during local work and a failure in CI. Neither result claims portal conformance. Portal Controls remain unresolved until identity is established.

## Source Scope

Control applicability uses relative POSIX globs. `files.include` limits a Control to matching source paths, and `files.exclude` removes matching paths from that set. Absolute paths, parent traversal, and backslashes are invalid. Web Doctor evaluates source scope without executing project configuration or policy code.

Portal membership, capabilities, dependency versions, runtime versions, and application metadata are conjunctive. A known mismatch means the Control does not apply. A missing required fact leaves applicability unresolved rather than guessing.

## Embedded Contributions

The installed package contains `generated/registry/snapshot.json` and only catalog-approved contribution files. Startup verifies manifest digests, documents, fixture expectations, runtime artifact digests, provenance, snapshot consistency, and the complete file set. A mismatch prevents startup.

Normal resolution never contacts npm, source Git repositories, or a Web Doctor service. Network denial does not change results for the same package and project state. Contribution changes arrive only in a new Web Doctor package.

## Update Status

When enterprise npm distribution is configured, update status compares the installed exact version with registry metadata. The result is `current`, `outdated`, or `unknown` and records the installation mode. Offline lookup, missing configuration, and invalid metadata return `unknown`; they do not interrupt offline policy resolution.

[`examples/runtime/update-states.json`](../examples/runtime/update-states.json) covers current, outdated, and offline states. An outdated warning identifies installed and available versions but does not change the process registry digest.

## Managed Upgrades

A managed standalone installation may update inside its enterprise tool cache. The updater retrieves one exact package with SHA-512 integrity and extracts it without lifecycle scripts. It runs a startup self-check before atomically replacing `active.json`. It retains `previous.json` for rollback. Any retrieval, integrity, self-check, or activation failure leaves the active pointer unchanged.

Rollback makes the retained previous version active and preserves the displaced version as the next rollback target. Running processes remain on their loaded package. The stable launcher observes the new pointer only when starting a new process.

## Package-Managed and Immutable Installs

Project dependencies, workspaces, global installs, and immutable CI remain under their package manager or image system. Web Doctor returns an exact command such as `npm install --save-dev --save-exact web-doctor@2.0.0` or an enterprise-approved image command. It never edits an application manifest, lockfile, installed package, or CI image.

Commit package-manager lockfiles and use clean or frozen install modes in CI. Do not use a dist-tag or mutable version range as evidence that a specific Web Doctor registry was installed.