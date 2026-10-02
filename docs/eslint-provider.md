# ESLint Provider

ESLint is Web Doctor's default engine for static source checks. Web Doctor runs ESLint 9 through its Node API in a bounded worker process. It uses the application's own configuration and adds only catalog-approved enterprise plugins. Effective policy decides which rules run and at what severity. Web Doctor reports findings and never changes source.

## Provider Contract

An ESLint provider is a contribution whose provider manifest declares `"engine": "eslint"` and an `engineRange` that includes the bundled ESLint version. The manifest `id` is the plugin namespace. Rules run as `<id>/<rule>` and must appear in the manifest's `rules` list. The contribution ships the plugin as a runtime artifact, such as `plugin.mjs`, whose default export has a `rules` object. The manifest records the artifact's SHA-256 digest.

A Control cites ESLint evidence in one of two forms:

- `{ "provider": "<manifest id>", "rule": "<rule>" }` names an approved plugin rule directly.
- `{ "provider": "eslint", "rule": "<namespace>/<rule>" }` names the same rule through the engine. A rule without a namespace, such as `no-debugger`, is a core ESLint rule.

`web-doctor provider validate` checks the manifest, the rule catalog, and the deterministic pass and fail fixtures before a contribution is published. See [Federated Contribution Authoring](federated-authoring.md).

## Configuration Composition

Web Doctor looks for the application's configuration from the application root up to the repository root:

1. A flat configuration file (`eslint.config.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, or `.cts`) is loaded as ESLint 9 loads it.
2. Otherwise, a legacy `.eslintrc.*` file or a `package.json` `eslintConfig` field is loaded as one root configuration. Nested `.eslintrc` files in subdirectories are not merged.
3. With no configuration, a base configuration parses JavaScript and JSX with ESLint's parser and TypeScript and TSX with `@typescript-eslint/parser`.

The application's parsers, language options, settings, and ignores apply. Its own rules do not run. If the configuration cannot be loaded or combined with the enterprise plugins, the ESLint providers are reported as unavailable and their Controls are incomplete. A plugin name that redefines an approved namespace is one example of such a conflict. Web Doctor never falls back to another configuration. Files the configuration cannot parse or does not match make the evidence partial, and the report names them.

## Plugin Approval

Only plugins embedded in the installed Web Doctor package run. Each one arrives through a reviewed catalog entry that pins an exact internal npm version and its registry integrity. Before a run, Web Doctor checks that the embedded artifact exists inside the registry and still matches its approved digest. The worker checks the digest again before it imports the plugin. A missing or altered artifact makes its provider unavailable, and the plugin never executes. A namespaced rule with no approved plugin is unavailable too, even if the application installs a plugin with that name. Application plugins can configure parsing but cannot supply evidence for enterprise Controls.

## Rule Selection and Severity

Web Doctor enables exactly the rules effective Controls require and filters out every other rule. A rule required by a `required` Control runs as an error; otherwise it runs as a warning. When several Controls require the same rule, one finding carries every applicable Control's obligation, each with its own remediation and verification. A Control that applies only to some files receives obligations only for findings in those files. A rule of type `problem` produces a `defect`; any other rule type produces a `risk`.

## Suppressions

Inline `eslint-disable` directives do not waive enterprise Controls. When a directive disables a policy-selected rule, the finding is still reported, with `suppression.kind` set to `inline` and the directive's justification. It counts toward the Control's outcome and the CI gate. To waive a Control, add an exception in `web-doctor.config.json` that the Control's exception policy authorizes. An unauthorized exception is reported as a conflict.

## Fixes

Web Doctor never applies fixes or suggestions. When ESLint offers one, the finding sets `fix.available` and describes it; `fix.applied` is always `false`. The developer or coding agent owns every source change.

## Bounded Execution

All ESLint providers for a run share one worker process. Node's permission model limits it to reading the application root, the repository root, Web Doctor itself, and the approved plugin directories. It cannot write anywhere except a private scratch directory that is deleted after the run. It cannot start processes, use workers, load native addons, or open network connections. A time limit, a memory limit, and an output limit bound the run. A crash, timeout, oversized result, or denied capability makes the ESLint providers unavailable without hiding other providers' results. The report names any capability a plugin tried to use.

## Changed Files and Baselines

A changed-file run lints only the files that changed since a base revision or the files you list. Controls whose file scope misses those files are reported as not evaluated. A changed-line run classifies findings outside the changed lines as `existing` debt and findings on them as `introduced`. A baseline report classifies findings by a fingerprint that ignores line numbers, so debt that edits moved is still recognized. The CI gate fails only on introduced findings.

## Example

[`examples/eslint/app`](../examples/eslint/app) is a small application checked with the [Adobe Analytics governance contribution](../examples/adobe-analytics-governance). [`examples/eslint/expected.json`](../examples/eslint/expected.json) lists its findings, Control outcomes, and gate result:

- `src/checkout.js` calls `alloy("sendEvent")` directly.
- `src/events.js` uses an event name outside the canonical taxonomy.
- `src/signup.js` sends an identifier field under an inline suppression, which is recorded and still counts.
- `src/tracking.js` uses the approved wrapper and produces no finding.
