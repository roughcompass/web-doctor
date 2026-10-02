# React Doctor Fleet Evaluation

This evaluation ran the approved React Doctor release through the Web Doctor adapter against all eight fleet applications, with every catalog rule selected. It measures output compatibility, latency, completeness, signal quality, and overlap with ESLint. The raw results are in [`evidence/react-doctor-evaluation.json`](../evidence/react-doctor-evaluation.json), and the finding review is in [`evidence/react-doctor-review.json`](../evidence/react-doctor-review.json).

Reproduce it from the Web Doctor repository:

```sh
node scripts/evaluate-react-doctor.mjs ../fleet
```

## Release Under Test

| Property | Value |
|---|---|
| React Doctor | 0.9.14 |
| npm integrity | `sha512-JzOwAY/hoSxHa4Siyqgfxr/KCNak0SB9pSTseFVStFHAnWS+XxR6RsWU6Q5Ho+J5Jmyb9LZRXc6ZK5jt3cfcQQ==` |
| Rule-set digest | `0d6d5a275acc0fe41d09058a1caa99d71d0360e02389cc7ea62499af80805968` |
| Rules | 906, of which 688 are enabled by default |
| Report schema | 3 |

## Results

| Application | Completeness | Files analyzed | Findings | Latency |
|---|---|---:|---:|---:|
| acme-platform | complete | 2 | 0 | 511 ms |
| legacy-portal | complete | 6 | 0 | 535 ms |
| mf-admin | complete | 7 | 1 | 533 ms |
| mf-billing | complete | 9 | 0 | 672 ms |
| mf-shell | complete | 11 | 1 | 539 ms |
| spa-orders | complete | 5 | 1 | 675 ms |
| spa-reports | complete | 4 | 0 | 524 ms |
| spa-root | complete | 9 | 0 | 529 ms |

Every run produced a schema 3 report that validated against the adapter's contract. Each run finished in under 0.7 seconds, and no network access was attempted. Each application tree was byte-identical before and after its run.

## Signal

The three findings were reviewed against their source:

- **mf-admin, `rerender-lazy-state-init`:** a true positive. `useState(shell.getTheme())` evaluates the initializer on every render.
- **mf-shell, `iframe-missing-sandbox`:** needs context. The hardening advice is valid, but the message overstates the risk, because the iframe is cross-origin. Check it against the legacy bridge before adding a sandbox.
- **spa-orders, `only-export-components`:** a true positive. The Vite application's component file also exports a helper function, which defeats Fast Refresh.

No finding was a false positive. The fleet is small, with about 40 source files, so these numbers bound React Doctor's behavior on this fleet only. The advisory pilot measures false-positive rates at scale.

## Overlap with ESLint

At the rule level, React Doctor duplicates three rules that ESLint and its React Hooks plugin already provide: `no-eval`, `rules-of-hooks`, and `exhaustive-deps`. None of the enterprise ESLint plugins in the catalog, for analytics and runtime governance, overlaps with React Doctor. React Doctor's 102 accessibility rules follow the names of `eslint-plugin-jsx-a11y`. No fleet application installs that plugin, so this evaluation could not compare them finding by finding. For each overlapping check, policy should select either the React Doctor rule or the ESLint rule, so one issue yields one finding.
