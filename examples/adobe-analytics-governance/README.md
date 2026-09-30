# Adobe Analytics Governance Example

This example is one npm contribution owned and released by the Digital Analytics Platform team. It contains three ESLint rules, three policy Controls, six executable fixtures, and one catalog identity. A production package can extend the same provider and policy manifests to hundreds of rules without adding packages per rule.

The rules govern an enterprise adapter over Adobe Experience Platform Web SDK:

- Application code calls `analytics.track`, not `alloy("sendEvent")` directly. The adapter owns consent handling, common XDM fields, datastream selection, and errors.
- Event names follow a lowercase `domain.object.action` taxonomy.
- Payloads do not contain obvious direct-identifier fields. Static checks complement rather than replace privacy review.

Adobe documents `sendEvent` as the primary Web SDK command for sending data and supports XDM and non-XDM payloads. Adobe also documents consent configuration through `defaultConsent` and `setConsent`. The enterprise adapter is an application architecture choice built over those APIs, not an Adobe requirement.

Package contents:

```text
web-doctor.json  contribution identity, files, provenance, and fixtures
provider.json    executable rule catalog
policy.json      Controls that select those rules
plugin.mjs       all rule implementations
fixtures/        deterministic pass and fail cases
```

Validate all rules and fixtures:

```sh
node dist/cli.js provider validate \
  --manifest examples/adobe-analytics-governance/provider.json \
  --contribution examples/adobe-analytics-governance/web-doctor.json \
  --plugin examples/adobe-analytics-governance/plugin.mjs \
  --fixture examples/adobe-analytics-governance/fixtures/no-direct-alloy-pass.json \
  --fixture examples/adobe-analytics-governance/fixtures/no-direct-alloy-fail.json \
  --fixture examples/adobe-analytics-governance/fixtures/canonical-event-pass.json \
  --fixture examples/adobe-analytics-governance/fixtures/canonical-event-fail.json \
  --fixture examples/adobe-analytics-governance/fixtures/no-identifiers-pass.json \
  --fixture examples/adobe-analytics-governance/fixtures/no-identifiers-fail.json \
  --json
```

Validate all policy references against the same provider manifest:

```sh
node dist/cli.js policy validate \
  --policy examples/adobe-analytics-governance/policy.json \
  --provider examples/adobe-analytics-governance/provider.json \
  --json
```

Before release, CI packs and publishes this directory once. The Web Doctor catalog then pins one exact npm version, SHA-512 integrity, and source commit for the complete analytics governance release.

References:

- [Adobe Web SDK `sendEvent`](https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/commands/sendevent/overview)
- [Adobe Web SDK `defaultConsent`](https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/commands/configure/defaultconsent)