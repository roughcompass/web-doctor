# Reading Web Doctor Guidance

Web Doctor's guidance tools explain what applies to a change and how to verify it. They never make the change. Each response states how strong its advice is, how confident Web Doctor is, and which policy the advice comes from. It also cites its project evidence and confirms that nothing was modified.

The CLI prints the same response envelope with `--json` that the MCP server returns. The examples below are real responses, validated against the `web-doctor.mcp-response` schema.

| Tool | CLI | Example |
|---|---|---|
| `effective_guidance` | `web-doctor policy effective --file <path>` | [`effective-guidance.json`](../examples/guidance-responses/effective-guidance.json) |
| `explain_finding` | `web-doctor explain finding <finding-id>` | [`explain-finding.json`](../examples/guidance-responses/explain-finding.json) |
| `plan_upgrade` | `web-doctor plan upgrade react 19` | [`plan-upgrade.json`](../examples/guidance-responses/plan-upgrade.json) |
| `plan_verification` | `web-doctor plan verification --file <path>` | [`plan-verification.json`](../examples/guidance-responses/plan-verification.json) |

## Recommendation Strength

Every obligation carries its Control's `strength`: `required`, `recommended`, or `informational`. Advice is mandatory only when a required effective Control supplies it. Look for the `mandatory` field on approved patterns, recommendations, and registry guidance. Everything else is optional, and its `tradeoffs` explain why you might decline it.

In the finding example, the Wealth portal's required Control supplies the approved `Dialog` component, so the pattern has `"mandatory": true`. Upgrade and verification plans are advisory. Their stages and items never become mandatory by themselves.

## Confidence and Uncertainty

Web Doctor states what it could not establish instead of guessing.

- A finding's `certainty` is `observed`, `inferred`, `unknown`, or `conflicting`.
- Registry guidance has an `effectiveClassification`. Guidance that claims a measured defect stays `measurement_required` until you supply profile evidence.
- A recommendation's `status` is `approved`, `generic`, `conflict`, or `stale`. `conflict` means Controls require different patterns; Web Doctor lists both and chooses neither.
- A shared-repair `owner` has a `certainty`. Its `uncertainty` list names what is invisible, such as consumers of a published package.
- An upgrade plan lists `unresolved` reasons, `unestablished` dependencies, and `manual` review that no static check can settle.
- A verification item is `satisfied`, `failed`, or `remaining`. Evidence of one kind never satisfies a requirement of another kind, and manual review is never satisfied automatically.

The envelope's `complete` is `false` whenever any of this leaves the answer partial, including skipped inputs and budget truncation.

## Policy Provenance

The envelope's `provenance.policy.digest` identifies the effective policy the answer used. Findings and plans repeat it as `policyDigest`, so a stale answer is detectable. Each obligation names its `layer`, `policy`, and `contribution`. Each approved pattern lists its `sources`: the Control, layer, strength, and policy that supplied it. `provenance.webDoctor.registryDigest` identifies the embedded registry the package shipped with.

## Project Evidence

Facts cite their origin. A fact view's `source` is `shared` for the pinned repo-facts document and `extension` for Web Doctor's own React and symbol facts. Its `category`, `key`, and `evidence` locate the file and lines behind it. Upgrade plans cite `resolved_dependencies`, `package_managers`, `runtime_requirements`, and `verification_commands` facts for versions and commands, and Web Doctor's source index for each API occurrence.

The envelope's `provenance.repoFacts` and `provenance.extensions` identify both chains: detector release, configuration digest, fact-document digest, extension-state digest, and any incomplete categories. The envelope's `evidence` lists every cited source location.

## Non-Modifying Behavior

Guidance data carries `"modifiesProject": false`. Findings report `fix.applied: false` even when a provider offers a fix. Every MCP tool declares `readOnlyHint: true` and `destructiveHint: false`. Asking the MCP server to fix a finding returns remediation and verification only. The CLI writes files only where you ask it to, with `check --report` or `agent install`.
