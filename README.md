# license-compliance-gate

Ever shipped a release only to have legal ask "wait, is this dependency
allowed?" This tool answers that question automatically, before you ship.

It looks at every package your Node project depends on, checks what license
each one uses, and tells you if any of them break your company's rules
(for example: "no GPL"). If something's not allowed, it fails the build —
like a safety check that runs before every release — and hands you a report
that shows exactly *why*: which package, which license, and the dependency
chain that pulled it in.

**60-second version:**

```bash
npm install -g license-compliance-gate
compliance-gate scan . --out report.html && open report.html
```

That's it. No config required — it ships with a sane default policy (block
copyleft licenses like GPL/AGPL) and reports on everything else.

## Table of contents

- [What it's built on](#what-its-built-on)
- [What you can do with it](#what-you-can-do-with-it)
- [Reading a report](#reading-a-report)
- [Monorepo support](#monorepo-support)
- [Setting your own rules](#setting-your-own-rules)
- [CI integration](#ci-integration)
- [Good to know / limitations](#good-to-know--limitations)
- [Using it as a library](#using-it-as-a-library)
- [Contributing / local development](#contributing--local-development)

## What it's built on

This tool doesn't reinvent the wheel — it combines two existing tools and
adds the one piece they were missing:

- **[`license-checker`](https://www.npmjs.com/package/license-checker)** —
  scans your project and figures out what license every dependency uses.
- **[`foss-notices-viewer`](https://www.npmjs.com/package/foss-notices-viewer)** —
  takes that scan and turns it into a readable report, and can tell you what
  changed between two scans.
- **What this package adds** — the actual "pass or fail" decision: a policy
  you control, a way to detect when a dependency quietly changes its license
  in an update, dependency-chain tracing so a violation isn't just a name on
  a list, and support for scanning many repos (or a whole monorepo) at once.

Ships as both ESM and CommonJS — `import` or `require("license-compliance-gate")`
both work, no extra config either way.

## What you can do with it

### 1. Stop a bad license before you release

Run this as part of your build or CI pipeline:

```bash
compliance-gate scan . --out compliance-report.xlsx
```

If any dependency uses a license your company doesn't allow, this command
exits with an error — so you can make it a required check that blocks a
release until it's fixed. It also saves a report you can hand to whoever
needs to review it. Add `--violations-only` to skip straight to the rows
that actually failed the gate — useful when a project has thousands of
components and you don't want to scroll past all of them to find the
handful that matter:

```bash
compliance-gate scan . --out compliance-report.html --violations-only
```

The report format is picked from the `--out` file extension:

| Extension | What you get |
| --- | --- |
| `.html` | Standalone page with filterable tables — open it and start clicking |
| `.xlsx` | Spreadsheet, good for sharing with legal/an auditor |
| `.md` | Markdown table, good for pasting into a PR or GitHub issue |
| `.json` | Raw data, good for feeding into another tool |
| `.xml` | JUnit XML — one `<testcase>` per component, `<failure>` for violations. Native in Azure DevOps (`PublishTestResults@2`); needs a marketplace action on GitHub (e.g. `dorny/test-reporter`) |
| `.sarif` | SARIF 2.1.0 — violations only, one result per policy violation. GitHub's native Code Scanning format (Advanced Security required on private repos); Azure DevOps needs a marketplace SARIF viewer extension |

By default this reads your real, installed `node_modules` (run
`npm install`/`yarn`/`pnpm install` first). Add `--source lockfile` to scan a
committed `package-lock.json` instead — no install required:

```bash
compliance-gate scan . --source lockfile --out compliance-report.html
```

`--source lockfile` is npm-only (an npm v7+ lockfile with a `packages` map)
and doesn't merge workspace packages the way a `node_modules`-backed scan
does — a monorepo scanned this way only sees the root's own lockfile entries.
When no `--source` is given, the default (`node_modules`) behavior is
unchanged.

### 2. Catch a dependency that quietly changed its license

Sometimes a library update switches to a different, less permissive license
without anyone noticing. This catches that:

```bash
compliance-gate drift . --fail-on-change --update-baseline
```

The first time you run this, it just takes a snapshot ("the baseline") of
what you currently depend on. Every time after that, it compares your
project against that snapshot and tells you what was added, removed, or
changed. Once you've reviewed the changes and they're fine, `--update-baseline`
saves the new snapshot so next time starts fresh from here.

### 3. Generate a report for an audit

If someone (a customer, an auditor, a lawyer) just wants a list of every
license you're using — no pass/fail, just the facts:

```bash
compliance-gate scan . --out notices.xlsx --no-fail
```

`--no-fail` means this always finishes successfully; it's just producing a
report, not gating anything. Swap `.xlsx` for `.md` or `.html` if a
spreadsheet isn't what the recipient wants.

### 4. Check many repositories at once

Useful when you're evaluating a company's codebase before an acquisition, or
auditing a bunch of internal repos in one go:

```bash
compliance-gate scan-workspace ./repo-a ./repo-b ./repo-c --out consolidated-report.html
```

This produces one report with a section per repo — each with its own
component table *and* its own gate result (PASSED/FAILED), plus an overall
summary rolled up across all of them at the top. That's deliberate: with
thousands of components across several repos, one giant merged table makes
it hard to tell which repo actually failed and why. If the same library
shows up in two different repos, it's listed once per repo — that's also
intentional, since each repo is its own separate legal exposure. In the
`.html` format, each repo's section is a collapsible `<details>` block (open
by default) so you can collapse the ones you don't need to look at.

**A "repo" here means a separate project directory you pass on the command
line — not a monorepo's internal packages.** Point `scan` or `scan-workspace`
at the *root* of a monorepo instead — see [Monorepo support](#monorepo-support).

`--violations-only` works here too, and filters each repo's section down to
its own failing rows independently — the overall and per-repo summaries
still report the true, unfiltered totals:

```bash
compliance-gate scan-workspace ./repo-a ./repo-b --out consolidated-report.html --violations-only
```

## Reading a report

Every report — `.json`, `.md`, `.html`, `.xlsx` — leads with the same
summary, so whoever opens it knows the verdict before reading a single row:

(`.xml`/JUnit and `.sarif` are CI-native formats, not human-reading formats —
see [CI integration](#ci-integration) for how each maps: JUnit shows every
component as a passing/failing test, SARIF shows only the policy violations
as findings.)

- **Repositories** scanned
- **Scanned at** — timestamp, so a report doesn't get mistaken for a fresher one
- **Total components** and **distinct licenses**
- **Compliance gate: PASSED / FAILED** with the violation count

For a `scan-workspace` report, that summary is the *overall* result across
every repo — below it, each repo gets its own section with its own summary
and its own gate result, not just a shared table (see
[Check many repositories at once](#4-check-many-repositories-at-once)).

Within each report (or each repo's section, for `scan-workspace`) is one row
per component: name, version, license, risk tier, a **Violation** column,
author, package URL, and — for any non-permissive license — a **Dependency
Chain** column (`your-app > some-lib > gpl-thing`) showing exactly how it got
pulled in. That last part is the difference between "GPL-3.0 flagged, good
luck" and "here's the one line to go fix."

The `.html` report additionally has **Risk**, **License**, and **Violations**
filter dropdowns above the table — narrow 3,000 components down to just the
ones that actually failed the gate in one click, no spreadsheet required.
(Or skip the click and pass `--violations-only` up front — see
[Stop a bad license before you release](#1-stop-a-bad-license-before-you-release).)

**Important: a non-permissive row isn't necessarily a violation.** The
component table shows *every* scanned component, including ones with a Weak
Copyleft or Unknown-risk license — those are shown for visibility, not
because they failed anything. Only the exact set of rows the gate itself
rejected are marked "Yes" in the Violation column, matched 1:1 against the
same policy evaluation that decides the exit code — so if you're
cross-checking "the table has more risky-looking rows than the gate
reported," that's expected under the default policy (see
[Setting your own rules](#setting-your-own-rules)); the Violation column (or
`--violations-only`) is the trustworthy source for "did this actually fail,"
not the Risk column.

## Monorepo support

**npm/yarn workspaces** — point `scan` or `scan-workspace` at the workspace
*root* and it correctly finds every dependency across all workspace packages
in one pass, correctly classifies each as direct or transitive (reading each
workspace package's own `package.json`, not just the root's), and correctly
traces the dependency chain for a violation even when the offending package
was only ever pulled in by one specific workspace package's own dependencies
— not the root's. Verified against a real ~3,500-component npm workspaces
monorepo, including a 5-hop chain (`root > workspace-pkg > devDependency >
... > gpl-package`).

What's still not covered: a workspace pattern using `**`, brace expansion, or
`!negation` is skipped with a console warning rather than silently
mismatched — only exact paths and a single trailing `/*` (e.g.
`"packages/*"`) are supported. Pointing a scan directly at one workspace
package's own subdirectory (e.g. `compliance-gate scan packages/pkg-a`)
mostly doesn't work — with dependencies hoisted to the root, that
subdirectory has no `node_modules` of its own, so the scan sees the package
itself and nothing it actually depends on. That's `license-checker`'s own
dependency resolution, not this package — scan from the workspace root
instead.

**pnpm monorepos need different handling, and get it.** pnpm never hoists
dependencies into the root `node_modules` the way npm/yarn workspaces do —
it links each package's dependencies from a `.pnpm` content store instead, so
a root-only scan would find nothing but the root package itself. When a
`pnpm-workspace.yaml` is present, `scan`/`scan-workspace` instead run
`license-checker` once at the root *and* once per workspace package (where
pnpm's symlinks do resolve), then merge the results, deduplicating by
`name@version`. Verified against a real `pnpm install`: a two-package pnpm
workspace root reports every real dependency, correctly classified direct
vs. transitive, with each workspace package's own name filtered back out so
it doesn't show up as noise alongside its real dependencies.

## Setting your own rules

By default, this tool only blocks "copyleft" licenses (like GPL and AGPL),
which are the ones most companies are cautious about. You can customize this
by adding a `compliance.config.json` file to your project:

```json
{
  "disallowedLicenses": ["Some-Specific-License-Legal-Rejected"],
  "disallowedRiskTiers": ["copyleft"],
  "licenseRiskMap": { "Some-Internal-License-1.0": "proprietary" }
}
```

- `disallowedLicenses` — block specific licenses by name.
- `disallowedRiskTiers` — block entire categories (like all copyleft licenses).
- `licenseRiskMap` — reclassify a license if you disagree with how it's
  categorized by default (see `foss-notices-viewer`'s docs for the built-in
  categories).

Point at a different config with `--policy <path>`, or skip the file
entirely and just pass `--policy` to a one-off config for testing changes
before committing to them.

## CI integration

Any CI system that fails a job on a non-zero exit code works — `scan` exits
`1` when the policy is violated:

```yaml
# GitHub Actions
- name: License compliance gate
  run: npx license-compliance-gate scan . --out compliance-report.html
- name: Upload report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: compliance-report
    path: compliance-report.html
```

`if: always()` on the upload step means the report gets attached to the run
whether the gate passed or failed — useful when someone asks "why did this
fail" three weeks later.

**GitHub Code Scanning (SARIF):**

```yaml
- name: License compliance gate
  run: npx license-compliance-gate scan . --out compliance-report.sarif --no-fail
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: compliance-report.sarif
```

`--no-fail` here because `upload-sarif` is how you want violations to surface
(as Code Scanning alerts) — let a separate step (or the same `scan` run
without `--no-fail`) still fail the job if you also want a hard gate.

**Azure DevOps (JUnit):**

```yaml
- script: npx license-compliance-gate scan . --out compliance-report.xml --no-fail
  displayName: License compliance gate
- task: PublishTestResults@2
  condition: always()
  inputs:
    testResultsFormat: JUnit
    testResultsFiles: compliance-report.xml
```

Each scanned component shows up as a "test" — failing ones are the license
violations, so the existing Azure DevOps test-results UI becomes the
violation report with no extra plugin.

## Good to know / limitations

- **Not a full legal-grade SBOM.** This scans your installed `node_modules`
  and reports what's actually there — it doesn't include full copyright text
  or a spec-compliant document. If you need that, generate one with
  `@cyclonedx/cyclonedx-npm` and feed it into `foss-notices-viewer` directly.
- **Requires `node_modules` to actually be installed, unless you pass
  `--source lockfile`.** By default this reads the real, installed
  dependency tree (the same way `license-checker` does) — run
  `npm install`/`yarn`/`pnpm install` first. `--source lockfile` reads a
  committed npm `package-lock.json` instead (no install needed) but is
  npm-only and doesn't merge workspace packages — see
  [Stop a bad license before you release](#1-stop-a-bad-license-before-you-release).
  Every CLI failure (a missing `package-lock.json` under `--source lockfile`,
  a bad `--policy` file, a bad scan target) prints a clean one-line message
  and exits 1 — not a Node stack trace.
- **A `compliance.config.json` with an unknown key or wrong-typed field now
  throws instead of silently falling back to the default policy.** This is a
  breaking change from earlier versions: a typo like `disallowedRiskTier`
  (missing the `s`) used to be silently ignored, gating on the default policy
  without telling you. It now fails fast with the exact bad key/type so a
  typo can't quietly disable your policy.
- **Path handling is audited for Windows, not run-tested there.** Every
  filesystem path goes through Node's own `path` module (`join`/`resolve`);
  the only literal `/` usage is against npm lockfile keys and `package.json`
  workspace globs, both forward-slash by spec on every OS. This CLI itself
  hasn't been executed on a Windows machine.
- **An unrecognized license defaults to "unknown" risk, and "unknown" isn't
  blocked by default.** This is deliberate — an unfamiliar license warns
  instead of silently failing every build the first time it's seen — but it
  means a genuinely bad license you've never encountered before won't block
  a release unless you add `"unknown"` to `disallowedRiskTiers` yourself.
- **The dependency chain shown is the shortest one, not every route.** A
  package can be pulled in by five different things; the report shows one
  honest example, not an exhaustive list.

## Using it as a library

Everything the CLI does is also exported for use directly in your own script
(a custom CI step, a dashboard, whatever the CLI's file-based reports don't
cover):

```ts
import { scanWithSource, evaluatePolicy, loadPolicyConfig, writeReport } from "license-compliance-gate";

const { document, chains } = await scanWithSource(".", "node_modules");
const policy = await loadPolicyConfig(); // DEFAULT_POLICY — pass resolvePolicyPath(dir, explicitPath) to auto-discover compliance.config.json like the CLI does
const violations = evaluatePolicy(document, policy);
await writeReport(document, "report.sarif", violations, chains);
```

## Contributing / local development

```bash
npm install
npm run build
npm test
```