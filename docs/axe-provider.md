# Axe Provider

The axe provider supplies rendered accessibility evidence. It loads running application states in Playwright's Chromium and checks them with axe-core. It runs only for an explicit, authorized runtime request. Web Doctor never discovers targets and never starts an application server.

## Proof Boundaries

A clean axe result means that the approved rules found no automatically detectable violation in the states that were tested. It does not establish WCAG conformance, and Web Doctor never reports it as such. Every Control with rendered evidence carries a limitation that names the tested states. It also lists the verification that automated checks cannot perform. That includes the Control's own manual steps and the states nobody tested. It also includes runtime accessibility guidance for keyboard use, focus, screen readers, zoom and reflow, and motion. Rules that axe cannot decide, such as contrast over a gradient, make that rule's evidence partial, so its Controls stay incomplete.

## Approval

The provider is a catalog contribution, shown in [`examples/axe-provider`](../examples/axe-provider). Its manifest declares the `axe-core` engine range, the `browser` and `network-target` capabilities, the `runtime` invocation mode, and the axe rules it approves. A ruleset artifact, pinned by digest, lists the approved rules. A run checks only rules that both the approved ruleset and effective policy name. The same contribution ships the runtime accessibility guidance entries.

## Runtime Requests

A runtime request is a JSON document with `"authorized": true` and one or more targets:

| Field | Meaning |
| --- | --- |
| `url` | The running target, over http or https |
| `route` | An optional route label reported with findings |
| `state` | The label of the application state the target represents |
| `viewport` | Width and height in CSS pixels; 1280 by 800 by default |
| `steps` | Declarative steps that bring the page to its state |
| `storageState` | An absolute path to a Playwright storage-state file for an authenticated target |

Targets must be loopback addresses. A remote target needs `"allowRemoteHosts": true` and an approved provider that declares `network-target`. A URL with embedded credentials is refused. Pass the request to `web-doctor check --runtime <file>`, or to the MCP `run_diagnostics` tool when the server runs with `--allow-runtime`.

## States and Steps

Each target loads in a fresh browser context. Steps then bring it to its state: `goto`, `click`, `fill`, `press`, and `waitFor`. Steps are data, not scripts, so a request cannot run code in Web Doctor. Give each state its own target and label, such as `menu-open` or `form-error`, so results show which states were checked.

## Authenticated Targets

Sign in once with your usual tooling, save Playwright's storage state, and reference the file from the target. Web Doctor reads the file only to create the browser context. It never copies the file's contents, its path, or cookie values into findings, reports, or MCP responses. Keep storage-state files outside the repository and delete them when you are done.

## Sensitive Output

Findings keep the rule, the rendered target's CSS selectors, a truncated failure summary, and the tested URL, route, state, and viewport. Web Doctor never captures page markup, screenshots, or traces. Keep secrets out of target URLs, because URLs appear in results.

## Failure Isolation

The browser runs in a bounded worker process. It is granted a scratch directory, the browser installation, the storage-state files, and network access for the targets. A target that is unreachable, answers with an HTTP error, times out, or crashes the page is reported and never stops the other targets. A browser that cannot start makes rendered evidence unavailable. None of these failures hides static findings from ESLint.

## Example

[`examples/axe/runtime-request.json`](../examples/axe/runtime-request.json) checks two states of a local test application. It opens a menu with steps and reaches an account page with the session in [`examples/axe/storage-state.json`](../examples/axe/storage-state.json). [`examples/axe/expected.json`](../examples/axe/expected.json) lists the findings, tested states, and Control outcomes.
