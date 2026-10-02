# Project Context

Web Doctor answers questions about one application checkout from three sources. The shared fact document comes from a pinned repo-facts detector release and is kept exactly as produced. The extension document holds Web Doctor's own facts under namespaced categories. The source index holds symbols, props, hooks, and references. Nothing in the checkout is executed, installed, or imported to produce any of them.

## Fact Ownership

| Source | Owner | Contents |
| --- | --- | --- |
| Shared fact document (`repo_facts.fact_document`) | repo-facts | Languages, submodules, package identity, workspaces, package managers, build tools, test frameworks, CI systems, scripts, verification commands, runtime requirements, dependencies, resolved versions, frameworks, composition, packages produced and consumed, runtime integrations, served origins, API contracts, test substitutes, egress routes, access signals, and Service Dependencies |
| Extension document | Web Doctor | `web-doctor.components`, `web-doctor.hooks`, `web-doctor.providers`, `web-doctor.entry_points`, `web-doctor.tests`, `web-doctor.routes`, and `web-doctor.source_relationships` |
| Source index | Web Doctor | Modules, imports, exports, top-level symbols, props, hook calls, rendered elements, contexts, providers, references, React roots, routes, single-spa lifecycles, frames, and message channels |

Web Doctor never edits, repairs, or reinterprets a shared fact, and it never reimplements a shared detector. Extension categories are registered through the shared contract, which rejects an un-namespaced id, a repeated id, or an id that collides with a shared category. Queries read shared categories only from the shared document and extension categories only from the extension document; a collision is refused, not overwritten. Extension facts that build on shared facts name them in a `shared_fact` field.

## Pinned Detector Provenance

Web Doctor depends on `@repo-facts/bundle` and `@repo-facts/contract` at one exact version, the detector release. `generated/repo-facts.json` records that release, its source commit, and each lockstep package's version, SHA-512 integrity, and installed-content digest. See [Shared Repository Facts Release](contracts.md#shared-repository-facts-release). At startup Web Doctor verifies that the packages it actually loads match that record.

Every query result reports both provenance chains:

- `provenance.shared`: the detector release, the detector-configuration digest, the fact-document digest, and the categories whose search was incomplete
- `provenance.extensions`: the extension release, the extension-document and index digests, the extension-state digest, and incomplete extension categories
- `provenance.treeDigest` and `provenance.snapshotDigest`: the working-tree content and the combined inputs of the answer

Shared context becomes `incomplete`, with the reason, when the release is missing or altered, the reader fails the shared contract, or the document is invalid. An unsupported fact-document schema or a digest mismatch has the same effect. Web Doctor then reports no shared facts; it never falls back to its own detectors.

## Convention-Tolerant Discovery

Discovery assumes no framework, router, build tool, package manager, language, or directory layout. The application root is the nearest `package.json`, widened to an enclosing npm or pnpm workspace root that includes it, and never beyond the Git working tree. `tsconfig.json` and `jsconfig.json` supply path aliases as data.

Each extension activates only on matching evidence:

- Build-configuration entries appear only when the shared document reports webpack, rspack, or Vite.
- React roots, routes, and single-spa lifecycles count only when the call or element resolves to an import from `react-dom`, `react-router`, or `single-spa-react`. A local function with the same name does not count.
- Test files need the `.test` or `.spec` suffix, or a `__tests__` directory, plus a declared test framework or an imported test package.
- Federated remote uses, frame hosts, and message channels need the matching shared composition or runtime-integration fact.
- Next.js file routes need the shared document to report Next.js.

## Certainty and Unresolved Values

Every fact is `observed` (read from a literal position), `inferred` (combined from signals, with `reasoning`), `unknown`, or `conflicting` (all candidates and their evidence, with no chosen value). A category with no facts is `absent` only after a complete search of its surface with nothing skipped, and only if it allows a bounded negative. Otherwise it stays `unknown`. Entry points, routes, and source relationships never report `absent`.

A value that is computed or unsupported stays unresolved. Web Doctor records that it observed the expression and never guesses its result. A build entry of `getEntries()` has `module: null` and `resolution: "computed"`. A route path built from a template has `path: { "kind": "computed" }`. An import that no admitted file satisfies stays unresolved. Query results list runtime-only portions under `unresolved`. These include hook results, context values, and props passed through a spread.

## Skipped Inputs

The shared reader records each input it refuses: path-rejected, protected, sensitive, symbolic link, submodule, missing, binary, oversized, or over budget. Detectors add parse failures. The shared result exposes these as `skippedInputs` and lists affected categories under `incompleteCategories`. The source index adds syntax errors and files beyond its file limit. A skipped input on a category's search surface keeps that category from being `absent`.

## Reader Exclusions

The working-tree reader lists what Git would see. It leaves out `.git`, dependency directories (`node_modules`, `bower_components`, `jspm_packages`), and paths excluded by committed `.gitignore` files, including those above the application root in the same repository. It also leaves out sockets, pipes, and devices. Each exclusion is recorded with its reason. Uncommitted `.git/info/exclude` and global excludes are not consulted, so every checkout of the same commit lists the same tree.

Within the listing, the shared read policy applies. Credential files stay visible but are never read. Protected directories are neither listed nor read. Symbolic links and submodules are metadata that is never followed. Each read re-verifies the listed Git object id and refuses a path component that has become a link. Content that changed or was swapped after listing is reported missing.

## Budgets

| Budget | Default | Effect |
| --- | --- | --- |
| Per-file bytes | 1,048,576 | Larger files are listed and skipped as `blob_too_large` |
| Files read | 4,000 | Reads beyond it are skipped in path order as `file_budget_exhausted` |
| Total bytes read | 67,108,864 | Reads beyond it are skipped in path order as `total_budget_exhausted` |
| Indexed source files | 4,000 | Further sources are skipped; the index is incomplete |
| Indexed symbols | 20,000 | Further symbols are counted but not indexed |
| Indexed references | 200,000 | Further references are counted but not listed |
| Query page | 50 (at most 500) | Results return a deterministic page, the total, and a continuation |

Budgets are spent in path order, so the same tree and requests always skip the same inputs. A continuation is bound to the query, its parameters, and the snapshot. After the project changes it is refused as stale instead of mixing two states. Truncated results include narrowing guidance, such as counts by kind and path.

## Live Updates

A long-running process watches the application root. After it observes a change, it rescans before answering, and it rescans again if another change arrives meanwhile. Shared facts are reused only for identical listed content. Extension facts are reused only when three things are unchanged: the files they read, the set of existing paths, and the shared facts they consume. Each refresh reports the extension facts it invalidated. Without a working watcher, every request rescans.

## Examples

Each example is checked against the golden fixture it names. The fixtures are vendored from the pinned release's source commit. The spa-orders example uses the spa-orders lifecycles input from repo-facts' own tests, because the release publishes no spa-orders golden document.

- [`examples/project-context/spa-root.json`](../examples/project-context/spa-root.json): the `single-spa-root` fixture, modeled on spa-root
- [`examples/project-context/spa-orders.json`](../examples/project-context/spa-orders.json): the spa-orders lifecycles input
- [`examples/project-context/mf-shell.json`](../examples/project-context/mf-shell.json): the `federation-shell` fixture, modeled on mf-shell
- [`examples/project-context/legacy-portal.json`](../examples/project-context/legacy-portal.json): the `legacy-portal` fixture
