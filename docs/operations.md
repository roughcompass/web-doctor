# Installing and Operating Web Doctor

Web Doctor is one package with a CLI and one local MCP server. This guide covers installation, portal selection, agent registration, CI, updates, offline use, rollback, and troubleshooting. Every command below runs from a clean installation; tests execute them against an installed package.

Placeholders use angle brackets. Replace `<base-revision>` with a commit or branch, `<finding-id>` with an id from a report, and `<control-id>` with a Control id.

## Install the Package

### As a project dependency

Install one exact version as a development dependency and commit the lockfile:

```sh
npm install --save-dev --save-exact web-doctor@0.1.0
```

The package manager owns this installation. Web Doctor never edits your manifest or lockfile. Confirm the installed version and its build inputs:

```sh
web-doctor version
web-doctor provenance
```

Run the commands through your package manager, for example `npx web-doctor version`, when `node_modules/.bin` is not on your path.

### As a managed installation

An enterprise launcher can run Web Doctor from a managed tool cache instead. Set `WEB_DOCTOR_INSTALLATION_MODE=managed` and `WEB_DOCTOR_MANAGED_ROOT` to the cache directory. The launcher runs the version that the cache's `active.json` pointer names.

Each version directory holds the package and the exact dependency tree its `npm-shrinkwrap.json` pins. A project installation gets the same tree, because npm honors the shrinkwrap there too.

## Choose Portals

Portal Controls apply only when a portal is selected. Name portals on the command line, or record them in `web-doctor.config.json` at the application root:

```json
{
  "schema": "web-doctor.repository-config",
  "schemaVersion": 1,
  "portals": ["wealth"]
}
```

Explicit portals never silently replace the configured set. If the two disagree, Web Doctor reports the conflict, and `check` exits with code 3.

```sh
web-doctor policy effective --portal wealth
web-doctor mcp --portal wealth
```

The `mcp` command serves the MCP protocol over standard input and output until the client disconnects. Rendered checks start a browser, so the server runs them only when launched with `--allow-runtime`.

## Register an Agent

Register the MCP server with a supported client: `claude-code`, `cursor`, or `vscode`. Registration writes the client's project configuration at the repository root and adds a short instruction block to `CLAUDE.md` or `AGENTS.md`.

```sh
web-doctor agent install --client claude-code --portal wealth
web-doctor agent uninstall --client claude-code
```

Both commands are idempotent. They change only Web Doctor's server entry and its marked instruction block. The instruction points agents to the MCP tools and never copies policy, which changes with each package release.

## Run in CI

`check` runs the providers that effective policy requires and exits with the gate's code. `--ci` makes incomplete required evidence fail, and `--report` writes the complete, redacted diagnostics report for archival:

```sh
web-doctor check --ci --changed <base-revision> --report web-doctor-report.json
web-doctor check --ci --gate recommended --json
```

| Exit code | Meaning |
|---:|---|
| 0 | The gate passed. Locally, incomplete evidence is advisory. |
| 2 | A Control at or above the gate has an introduced finding. |
| 3 | Portal selection or policy has a conflict. |
| 4 | In CI, a gated Control lacks complete required evidence. |
| 64 | The command line is invalid. |

`--changed` checks files changed since the base revision, including untracked files. `--changed-lines` narrows findings to changed lines. Both name the checks that need a full-project run. The gate level defaults to `required` or to `ci.gate` in the repository configuration.

## Update the Package

Update checks are off unless an enterprise registry is configured. Set `WEB_DOCTOR_UPDATE_REGISTRY` to its HTTPS URL, then check the installed version:

```sh
web-doctor update status
web-doctor update
```

A managed installation verifies the approved release's SHA-512 integrity and stages it. It installs the release's pinned dependencies from the shrinkwrap in the package, from the update registry, with scripts disabled. It then runs a startup self-check and switches the active pointer. Running processes keep their version until restart. A project or CI installation is never changed. When a newer release is approved, `update` prints the exact package-manager command and exits with code 2.

## Work Offline

Web Doctor needs no network. Policy, guidance, and providers come from the registry snapshot embedded in the package. Project facts come from the pinned repo-facts release installed with the package. Every response names the package version, registry digest, detector release, configuration digest, and fact-document digest. Without an update registry, `update status` reports `unknown` and never claims the package is current.

## Roll Back

For a project installation, install the prior exact version and restore its lockfile. For a managed installation, reactivate the retained previous version:

```sh
web-doctor update rollback
```

Rollback affects new processes only. A running MCP server keeps its package and registry snapshot until it restarts.

## Troubleshoot Problems

Start with the project overview. It lists each fact category, whether its search completed, and any skipped inputs:

```sh
web-doctor context overview --json
web-doctor explain control <control-id>
web-doctor explain finding <finding-id> --report web-doctor-report.json
```

| Symptom | Cause and fix |
|---|---|
| `Shared repository facts are unavailable` | The installed repo-facts packages differ from the recorded release. Reinstall the exact Web Doctor version with a clean install. |
| A category is listed as incomplete | An input was skipped: it was too large, sensitive, protected, or unparseable. The overview names the category; fix the input or accept the incomplete answer. |
| Exit code 3 in CI | Explicit portals conflict with `web-doctor.config.json`, or policy has a conflict. `policy effective` shows which. |
| Exit code 4 in CI | A gated Control needs evidence that did not run, such as rendered checks without a runtime request. |
| `Rendered checks were not run` | Pass `check --runtime <request.json>`, or start the MCP server with `--allow-runtime`. |
| `stale_continuation` | The project changed after a truncated response. Repeat the request without the continuation. |
| `Redacted N sensitive values` | A response quoted a credential. The value is replaced with `[redacted]`; nothing else changed. |
| `Response budget` warning | The response was windowed to fit its byte budget. Pass the continuation to read the rest, or narrow the request. |
