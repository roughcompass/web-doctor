# React Doctor Provider

React Doctor is an optional static provider that adds React-specific checks for bugs, performance, security, accessibility, and maintainability. Web Doctor runs it only under the recorded approval in [`approvals/react-doctor.json`](../approvals/react-doctor.json), and only when effective policy asks for one of its rules. ESLint, axe, project context, and every other provider work the same whether React Doctor is present, absent, or refused.

## Decision

React Doctor 0.9.14 is approved for internal enterprise use. The Web Doctor product owner approved it on 2026-09-30, after the legal and security reviews below. The approval record holds both decisions, their conditions, the exact invocation, and the pinned release. Changing any of them means changing that reviewed file.

## Legal Review

React Doctor ships under a Modified MIT License from Million Software, Inc. It grants the usual MIT permissions and reserves two uses for Million Software's prior written permission:

1. Using the software, its source, or derivative works as training, fine-tuning, or evaluation data, or as input to any pipeline that trains or improves a machine-learning model or AI system.
2. Selling the software, or offering it to third parties as a paid, hosted, or managed service whose value derives substantially from it.

Running React Doctor inside the enterprise as a diagnostic is neither use, even when coding agents read its findings while they work. Two conditions follow. React Doctor output must never enter an AI training or evaluation dataset, including pilot data. Web Doctor must not be offered to third parties as a service built on React Doctor. The installed package keeps its license notice.

## Security Review

React Doctor's defaults reach the network and can change the application. Web Doctor turns each of these off and checks the result:

| Behavior | Default | In Web Doctor |
|---|---|---|
| Crash reports and usage counters (Sentry, Axiom) | On | `--no-telemetry`, and the network guard blocks every connection |
| Score and share API | On | `--no-telemetry` disables it, and the guard blocks it |
| Socket.dev supply-chain lookups | On | `--no-supply-chain`, and the guard blocks it |
| Scan cache and settings in the home directory | Home directory | A private scratch directory that Web Doctor deletes after the run |
| `install`, `ci`, `scan <url>`, and rule-editing commands | Available | Never run; they write agent configuration, CI workflows, or config files |
| Audit mode, which rewrites source to neutralize suppressions | Off | Never passed |
| Executable `doctor.config.ts` or `.js` | Loaded | React Doctor is refused for that application; `doctor.config.json` is data and allowed |
| Configuration in parent directories | Loaded | Invisible, because reads outside the application look like missing files |
| `nvm install` when Node is too old | Attempted | Impossible, because the process gets no `PATH` |

React Doctor runs in a bounded Node process under the permission model. It can read the application, React Doctor itself, and the workspace-marker files it checks in parent directories. It can write only its scratch directory and the absent `.react-doctor/audit-backups` path. It may start its linter and use worker threads and native addons, which its parser needs. The network guard and read confinement travel to every child Node process through `NODE_OPTIONS`. The run has time, memory, and output limits. A network attempt is refused and reported, even when React Doctor ignores the error.

Web Doctor refuses to run React Doctor when leftover `.react-doctor/audit-backups` exist, because React Doctor would restore them into source files.

### Package Provenance and Update Cadence

React Doctor 0.9.14 was published on 2026-09-12 through GitHub Actions trusted publishing. It carries an SLSA v1 provenance attestation and two npm registry signatures. The project releases often and is still pre-1.0. It has published 114 stable releases since February 2026, 32 of them since July, and 704 development builds. Web Doctor therefore pins one exact release and never follows a range or a dist-tag.

## Supported Version Policy

Web Doctor pins one exact React Doctor release as an optional dependency, recorded in `npm-shrinkwrap.json`. The approval lists each approved release with its npm integrity, installed-content digest, rule-set digest, and supported report schema. At run time, the adapter refuses an installed copy whose version or files differ. It also refuses a rule catalog that differs from the approved rule set, or a report whose schema is not approved. At release time, registry validation refuses a provider that names any other version or a version range.

Moving to a new React Doctor release takes four steps:

1. Add a release entry to the approval with its digests, after reviewing the release's license, network endpoints, and write behavior.
2. Regenerate the rule catalog and provider manifest, and update the pinned dependency.
3. Run the adapter contract tests and the fleet evaluation, and review every new finding.
4. Publish a new Web Doctor package and a new provider contribution version.

## Rollback

To stop using React Doctor, remove its provider contribution from the catalog, or retire the Controls that name its rules. Then publish a new Web Doctor package. To return to an earlier React Doctor release, restore the earlier provider contribution and dependency pin. The approval must already list that release. Nothing else changes: the MCP tools, finding contract, and other providers do not depend on React Doctor.

## Provenance Shown to Users

Every React Doctor finding has the same normalized shape as any other finding. Its `provider` names the provider contribution, its version, the `react-doctor` engine, and the exact React Doctor version that ran. `original` keeps React Doctor's plugin, rule, category, tags, and help text. The diagnostics report's run entry for `react-doctor` shows completeness, the reason for any skipped check, the capabilities used, and any denied access. The response envelope carries the registry digest, which pins the approved provider contribution.

## Evaluation

The compatibility and signal evaluation against the fleet is in [React Doctor fleet evaluation](react-doctor-evaluation.md).
