# Web Doctor Overview and Operator Runbook

Web Doctor gives developers and coding agents evidence-based answers about a React application. It covers the application's structure, the enterprise policy that applies, findings from approved analyzers, and how to verify a change. This page explains how the product fits together and how to operate it. For command details, see [Installing and operating Web Doctor](operations.md).

## One Package and One MCP Server

Web Doctor ships as one npm package with a `web-doctor` CLI and one local MCP server, `web-doctor mcp`. Both use the same core, so equivalent requests return identical responses from either surface. The package embeds an immutable registry snapshot of every approved policy, provider, and guidance contribution. It also pins one exact repo-facts detector release for shared repository facts.

A process keeps its package and snapshot until it exits. New contributions arrive only in a new package release, never from a runtime service.

## Policy Layers

Controls come from four layers: firmwide, portal, platform, and application. Compatible Controls accumulate, so a finding carries every obligation that applies to it. A later layer cannot weaken an earlier Control; an attempt is reported as a conflict. An application can remove a Control only through an exception the Control's owner authorizes.

## Multiple Portals

An application can belong to several portals. Portal selection is a set, taken from explicit CLI or MCP arguments and from `web-doctor.config.json`. A portal Control applies when its portals intersect the selection. When explicit portals and the configuration disagree, Web Doctor reports the conflict and chooses neither. CI requires a selected portal unless the configuration sets `ci.requirePortal` to `false`.

## Provider Proof Boundaries

Each evidence kind proves only what it can observe:

- **Static:** ESLint covers the files the application's configuration can analyze. An inline suppression is recorded for review and never waives a Control.
- **Rendered:** axe covers the rules it can decide in the states you asked it to test. A clean run never establishes conformance, and untested states stay open.
- **Measured:** performance claims need supplied profile evidence of the same interaction.
- **Manual:** keyboard, screen-reader, and design review are never satisfied automatically.

A provider that fails, times out, or is not approved leaves its evidence unavailable. A Control that requires that evidence is incomplete, never met.

## Authoring and Approval

Contribution teams author policy, provider, and guidance packages in their own repositories. The steps are in [Federated contribution authoring](federated-authoring.md):

1. Start from a template and validate it with `web-doctor policy validate` or `web-doctor provider validate`.
2. Pack it with `web-doctor contribution pack` and publish the exact version to the internal npm registry.
3. Propose the catalog change with `web-doctor contribution propose`, which records the published integrity.

Platform reviewers approve catalog changes with the [Platform Contribution Review Checklist](platform-review-checklist.md) and CODEOWNERS. Release CI then regenerates the lock and embedded snapshot, as [Package assembly and release](package-release.md) describes, and publishes a new Web Doctor package.

## From Installation to a First Explained Finding

Install the package, look at the project, resolve policy for a portal, run the checks, and explain a finding:

```sh
npm install --save-dev --save-exact web-doctor@0.1.0
web-doctor context overview
web-doctor policy effective --portal wealth
web-doctor check --portal wealth --report web-doctor-report.json
web-doctor explain finding <finding-id> --portal wealth --report web-doctor-report.json
```

Pass the same portals to `explain` that `check` used, so the explanation resolves the same effective policy. `check` prints each finding's id under its location and exits with code 2 when a required Control has a finding. The explanation lists every obligation, the approved pattern or generic remediation, and the verification that remains. When several findings share one component, it also names that likely owner.

## Operator Troubleshooting

| Symptom | Cause and action |
|---|---|
| Release validation says manifest provenance does not match | The catalog names a different source commit than the package manifest. Propose the catalog change again from the published package. |
| An integrity check fails during release | The registry served different bytes for a pinned version. Never republish a version; select a retained exact version. |
| Startup reports an embedded registry mismatch | Files in the installed package changed. Reinstall the exact package with a clean install. |
| Shared repository facts are unavailable | The installed repo-facts packages differ from the recorded release. Reinstall the exact Web Doctor version. |
| A Control stays incomplete | Required evidence did not run. The diagnostics report names each provider's completeness and reason. |
| Release verification reports stale files | The lock or generated snapshot differs from a fresh build. Rebuild and commit them together. |

Developer-facing symptoms, exit codes, and continuation errors are in [Installing and operating Web Doctor](operations.md#troubleshoot-problems).
