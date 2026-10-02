# Advisory Pilot Runbook

The pilot runs Web Doctor in advisory mode on a few applications in selected portals. It gathers the evidence a platform readiness review needs before any Control gates CI. During the pilot, nothing fails a build: developers and agents use the findings, and the pilot records how well they hold up.

## Choose the Scope

Pick two or three portals and a handful of applications in each. Include one application of each kind the fleet has: a single-page application, a module federation host and remote, and a legacy application. Record each application's portals in its `web-doctor.config.json`. Keep `ci.gate` unset, and run `check` without `--ci`, so incomplete evidence stays advisory and findings never block.

## Capture Each Run

Wrap each command a developer or agent runs, so it is timed and its full response is kept:

```sh
node scripts/pilot-record.mjs --pilot pilot --app orders -- check --portal wealth
node scripts/pilot-record.mjs --pilot pilot --app orders -- context overview
```

Each run is saved in `pilot/records/` with its command, exit code, elapsed time, and response envelope. Set `WEB_DOCTOR_BIN` when the CLI is not on the path. The wrapper only observes Web Doctor, which still changes nothing in the application.

## Review Findings and Tasks

For each finding a developer reviews, add an entry to `pilot/dispositions.json`:

```json
[{ "fingerprint": "…", "verdict": "false_positive", "reviewer": "orders team", "reason": "The iframe is same-team and sandboxed upstream" }]
```

The verdicts are `true_positive`, `false_positive`, `wont_fix`, and `needs_context`. Use the finding's `fingerprint`, which survives unrelated edits, rather than its `id`.

For each task a developer or agent attempts with Web Doctor's help, add an entry to `pilot/tasks.json` with its `actor` (`developer` or `agent`), `outcome` (`success`, `partial`, or `failure`), the `tools` used, and notes.

Do not put React Doctor findings into any dataset used to train, fine-tune, or evaluate an AI model. The React Doctor approval forbids that use without Million Software's written permission. The pilot's agent task log records only outcomes and tool names, so it stays within that condition.

## Summarize the Pilot

```sh
node scripts/pilot-summary.mjs pilot --out pilot/summary.json
```

The summary reports latency per command, provider runs that were incomplete and why, and suppressed findings. It also covers dispositions and false-positive rates for each Control, and developer and agent task success. It then marks which Controls meet the readiness criteria:

| Criterion | Threshold |
|---|---:|
| Reviewed findings | at least 20 |
| False-positive rate | at most 5% |
| Incomplete evaluations | at most 5% |
| Suppressed findings | at most 10% |

Compare the latency results with the service-level targets in [Performance budgets and fleet compatibility](performance.md).

## Hold the Readiness Review

The platform readiness review decides which Controls may gate CI, at which strength. Record the decision in `pilot/readiness-review.json`:

```json
{ "heldOn": "2026-11-02", "approvedBy": "Platform review", "approvedForGating": [{ "control": "firm/accessibility/button-name", "gate": "required" }] }
```

Run the summary again after recording the review. Its `approvedWithoutMeetingCriteria` list must be empty. Any Control on it was approved without the evidence the criteria require. Revisit that approval before any application turns on `--ci` or `ci.gate` for it.
