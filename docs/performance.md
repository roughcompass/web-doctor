# Performance Budgets and Fleet Compatibility

Web Doctor is held to approved performance budgets, measured on the eight fleet repositories. The same fleet proves that every project-context stage runs on each repository, or reports why it cannot. This page states the budgets, how they were set, and how to check them.

## Budgets

Each budget is a 95th-percentile limit. Interactive answers stay under one second, and a cold command answers in under two and a half seconds. The budgets are in [`performance/budgets.json`](../performance/budgets.json), and the measurements behind them are in [`evidence/performance-baseline.json`](../evidence/performance-baseline.json).

| Operation | Fleet p95 | Budget |
|---|---:|---:|
| Cold CLI start to first answer | 484 ms | 2,500 ms |
| Load and verify the registry snapshot | 6 ms | 250 ms |
| Scan the working tree | 2 ms | 250 ms |
| Run the repo-facts bundle | 121 ms | 1,000 ms |
| Build the extension index | 11 ms | 750 ms |
| Answer after one source edit | 137 ms | 750 ms |
| ESLint diagnostics with a 20-rule baseline | 247 ms | 3,000 ms |
| React Doctor diagnostics | 660 ms | 4,000 ms |
| Warm MCP answer | 5 ms | 250 ms |

The measurements took three runs across all eight repositories on Node 24, on an Apple Silicon laptop. Each budget leaves several times the measured value as headroom, so slower CI runners pass while a real regression fails.

## Service-Level Targets

The fleet repositories are small, so their budgets guard against regressions rather than predict large-application speed. For a typical enterprise application of about 2,000 source files, the targets are:

| Operation | Target |
|---|---:|
| Cold start | 5 s |
| Answer after one source edit | 1 s |
| MCP answer | 1 s |
| Changed-file diagnostics | 15 s |
| Full diagnostics | 2 min |

The advisory pilot measures these on real applications before any Control gates CI.

## Check the Budgets

Measure the fleet and fail on any budget over its limit:

```sh
npm run test:performance
```

The test builds a measurement registry, runs [`scripts/measure-performance.mjs`](../scripts/measure-performance.mjs) three times over every repository, and fails when a 95th percentile exceeds its budget. It runs alone, because timing under other test load is noise. The normal suite checks the budget logic and the recorded baseline instead.

## Fleet Compatibility

From a managed installation on Node 24, [`scripts/evaluate-fleet.mjs`](../scripts/evaluate-fleet.mjs) runs each stage on its own for every repository:

- the working-tree reader
- the pinned repo-facts bundle
- the Web Doctor extension index
- policy resolution

The results are in [`evidence/fleet-evaluation.json`](../evidence/fleet-evaluation.json), and the expected outcome for each repository is in [`evidence/fleet-expectations.json`](../evidence/fleet-expectations.json).

Every stage completed or reported a named incomplete condition. The reader and the index completed on all eight repositories. repo-facts marked `served_origins` incomplete on every repository, and `egress_routes` or `verification_commands` on some, and it named each category. Policy resolution left portal Controls and the application-metadata Control unresolved, because the fleet selects no portal and records no metadata. Every result carries the detector release, configuration digest, fact-document digest, extension-state digest, and effective-policy digest. No repository script ran, no network connection opened, and no repository changed.

The fleet test compares each repository's outcome with its recorded expectation, so any change fails until it is reviewed.
