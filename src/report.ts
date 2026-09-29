import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import { queryNotices, toExportRows, type NoticesDocument } from "foss-notices-viewer";
import type { PolicyViolation, RepoScanResult } from "./types.js";

/** One row of a report's component table. */
export interface ReportRow {
  name: string;
  version: string;
  license: string;
  risk: string;
  author: string;
  purl: string;
  /** True when this exact `name@version` is one of the policy violations
   * that failed the gate — distinct from `risk`, since a "Weak Copyleft" or
   * "Unknown" row is still shown for visibility even though the *default*
   * policy only blocks "Copyleft". Only set when `toReportRows` is given
   * `violations`. */
  violation?: boolean;
  /** Root -> ... -> this package, joined with " > ". Only set for a
   * non-permissive license — see `toReportRows`. */
  chain?: string;
}

/** Report-wide facts shown once, above the per-component table, in every format. */
export interface ReportSummary {
  repos: string[];
  scannedAt: string;
  totalComponents: number;
  distinctLicenseCount: number;
  violationCount: number;
  gatePassed: boolean;
}

/** One repo's slice of a multi-repo (`scan-workspace`) report — its own
 * summary/gate result and its own component rows, kept separate so a reader
 * can tell at a glance which repo failed and why, instead of hunting through
 * one giant merged table. */
export interface RepoReportSection {
  repo: string;
  summary: ReportSummary;
  rows: ReportRow[];
}

/** A full `scan-workspace` report: one gate result across every repo, plus
 * each repo's own section. */
export interface WorkspaceReport {
  overall: ReportSummary;
  repos: RepoReportSection[];
}

const COLUMNS = ["name", "version", "license", "risk", "author", "purl"] as const;
const HEADERS: Record<(typeof COLUMNS)[number], string> = {
  name: "Package Name",
  version: "Version",
  license: "License",
  risk: "Risk",
  author: "Author",
  purl: "Package URL",
};

/**
 * Flattens a scanned document down to `ReportRow`s. When `chains` is given,
 * attaches the dependency chain for any row whose license isn't
 * "permissive", so a reviewer can see exactly why a copyleft/proprietary/
 * unknown license ended up in the tree. When `violations` is given, marks
 * `violation: true` on the exact rows `evaluatePolicy` flagged — the single
 * source of truth for what actually failed the gate, so this never
 * re-derives (and risks disagreeing with) that decision.
 */
export function toReportRows(
  document: NoticesDocument,
  chains?: ReadonlyMap<string, string[]>,
  violations?: PolicyViolation[],
): ReportRow[] {
  const violationKeys = new Set(violations?.map((v) => `${v.component}@${v.version ?? ""}`));
  return toExportRows(document).map((row) => {
    const tagged: ReportRow = { ...row };
    if (violationKeys.has(`${row.name}@${row.version}`)) tagged.violation = true;
    // toExportRows's `risk` is the display label ("Permissive"), not the raw RiskTier ("permissive").
    if (chains && row.risk.toLowerCase() !== "permissive") {
      const chain = chains.get(`${row.name}@${row.version}`);
      if (chain) tagged.chain = chain.join(" > ");
    }
    return tagged;
  });
}

/** Keeps only rows that failed the gate — use with `--violations-only` so a
 * huge scan doesn't bury the handful of components that actually matter. */
export function filterViolationRows(rows: ReportRow[]): ReportRow[] {
  return rows.filter((row) => row.violation === true);
}

/** Total components, distinct license count, and gate pass/fail — computed once and rendered identically in every format. */
export function buildSummary(rows: ReportRow[], repos: string[], violations: PolicyViolation[]): ReportSummary {
  return {
    repos,
    scannedAt: new Date().toISOString(),
    totalComponents: rows.length,
    distinctLicenseCount: new Set(rows.map((row) => row.license)).size,
    violationCount: violations.length,
    gatePassed: violations.length === 0,
  };
}

/**
 * Builds a `scan-workspace` report: one section per repo (its own summary
 * and rows), plus one overall summary rolled up across all of them. The
 * summary always reflects every component scanned, even with
 * `violationsOnly` set — only the *displayed* rows are filtered down, so a
 * report never silently under-reports how much was actually scanned.
 */
export function buildWorkspaceReport(
  results: RepoScanResult[],
  { violationsOnly = false }: { violationsOnly?: boolean } = {},
): WorkspaceReport {
  const sections = results.map((result) => {
    const rows = toReportRows(result.document, result.chains, result.violations);
    const summary = buildSummary(rows, [result.repo], result.violations);
    return { repo: result.repo, summary, rows };
  });
  const overall = buildSummary(
    sections.flatMap((section) => section.rows),
    sections.map((section) => section.repo),
    results.flatMap((result) => result.violations),
  );
  const repos = violationsOnly
    ? sections.map((section) => ({ ...section, rows: filterViolationRows(section.rows) }))
    : sections;
  return { overall, repos };
}

type Column = (typeof COLUMNS)[number] | "violation" | "chain";

function columnsFor(rows: ReportRow[]): Column[] {
  const columns: Column[] = [...COLUMNS];
  if (rows.some((row) => row.violation !== undefined)) columns.splice(4, 0, "violation");
  if (rows.some((row) => row.chain !== undefined)) columns.push("chain");
  return columns;
}

function headerFor(column: Column): string {
  if (column === "violation") return "Violation";
  if (column === "chain") return "Dependency Chain";
  return HEADERS[column];
}

function cellValue(row: ReportRow, column: Column): string {
  if (column === "violation") return row.violation ? "Yes" : "";
  return row[column] ?? "";
}

/** `includeRepos: false` drops the "Repositories" line — used for a single
 * repo's own section, where the heading above it already names the repo. */
function summaryLines(summary: ReportSummary, { includeRepos = true }: { includeRepos?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (includeRepos) lines.push(`Repositories: ${summary.repos.join(", ")}`);
  lines.push(
    `Scanned at: ${summary.scannedAt}`,
    `Total components: ${summary.totalComponents}`,
    `Distinct licenses: ${summary.distinctLicenseCount}`,
    `Compliance gate: ${summary.gatePassed ? "PASSED" : "FAILED"} (${summary.violationCount} violation(s))`,
  );
  return lines;
}

const escapeMarkdown = (value: string) => value.replace(/\|/g, "\\|");

function markdownTable(rows: ReportRow[]): string[] {
  const columns = columnsFor(rows);
  return [
    `| ${columns.map(headerFor).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((c) => escapeMarkdown(cellValue(row, c))).join(" | ")} |`),
  ];
}

/** Renders rows as GitHub-flavored Markdown — pipes in cell values are escaped since they'd otherwise break the table grid. */
export function toMarkdownReport(rows: ReportRow[], summary: ReportSummary): string {
  return [
    "## Summary",
    "",
    ...summaryLines(summary).map((line) => `- ${line}`),
    "",
    "## Components",
    "",
    ...markdownTable(rows),
  ].join("\n") + "\n";
}

/** Renders a `scan-workspace` report as Markdown — one `##` section per repo, each with its own summary and table, so a failing repo is easy to find without scanning one huge merged table. */
export function toMarkdownWorkspaceReport(report: WorkspaceReport): string {
  const lines = ["## Summary", "", ...summaryLines(report.overall).map((line) => `- ${line}`)];
  for (const section of report.repos) {
    lines.push(
      "",
      `## ${section.repo}`,
      "",
      ...summaryLines(section.summary, { includeRepos: false }).map((line) => `- ${line}`),
      "",
      ...markdownTable(section.rows),
    );
  }
  return lines.join("\n") + "\n";
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const HTML_STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
  th { background: #f2f2f2; }
  .summary { background: #f8f8f8; border: 1px solid #ddd; border-radius: 6px; padding: 0.8rem 1.2rem; margin-bottom: 1rem; }
  .summary p { margin: 0.25rem 0; }
  .gate.pass { color: #1a7f37; font-weight: bold; }
  .gate.fail { color: #cf222e; font-weight: bold; }
  .filters { margin-bottom: 1rem; }
  .filters label { margin-right: 1.5rem; }
  details.repo { border: 1px solid #ddd; border-radius: 6px; margin-bottom: 1rem; padding: 0 1rem 1rem; }
  details.repo summary { cursor: pointer; padding: 0.8rem 0; font-size: 1.1rem; font-weight: 600; list-style: revert; }
  details.repo summary .gate { margin-left: 0.5rem; }
`;

const FILTER_SCRIPT = `
(function () {
  var riskFilter = document.getElementById("riskFilter");
  var licenseFilter = document.getElementById("licenseFilter");
  var violationFilter = document.getElementById("violationFilter");
  function applyFilters() {
    var risk = riskFilter.value;
    var license = licenseFilter.value;
    var violation = violationFilter ? violationFilter.value : "";
    document.querySelectorAll("tbody tr").forEach(function (row) {
      var matchesRisk = !risk || row.dataset.risk === risk;
      var matchesLicense = !license || row.dataset.license === license;
      var matchesViolation = !violation || row.dataset.violation === violation;
      row.style.display = matchesRisk && matchesLicense && matchesViolation ? "" : "none";
    });
  }
  riskFilter.addEventListener("change", applyFilters);
  licenseFilter.addEventListener("change", applyFilters);
  if (violationFilter) violationFilter.addEventListener("change", applyFilters);
})();
`;

function htmlPage(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>License Compliance Report</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<h1>License Compliance Report</h1>
${body}
</body>
</html>
`;
}

function summaryBox(summary: ReportSummary, { includeRepos = true }: { includeRepos?: boolean } = {}): string {
  const gateClass = summary.gatePassed ? "pass" : "fail";
  const gateLabel = summary.gatePassed ? "PASSED" : "FAILED";
  const reposLine = includeRepos
    ? `<p><strong>Repositories:</strong> ${escapeHtml(summary.repos.join(", "))}</p>\n  `
    : "";
  return `<div class="summary">
  ${reposLine}<p><strong>Scanned at:</strong> ${escapeHtml(summary.scannedAt)}</p>
  <p><strong>Total components:</strong> ${summary.totalComponents}</p>
  <p><strong>Distinct licenses:</strong> ${summary.distinctLicenseCount}</p>
  <p><strong>Compliance gate:</strong> <span class="gate ${gateClass}">${gateLabel}</span> (${summary.violationCount} violation(s))</p>
</div>`;
}

function filterDropdowns(rows: ReportRow[]): string {
  const optionsFor = (values: Iterable<string>) =>
    [...new Set(values)]
      .sort()
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join("");
  const violationFilter = rows.some((row) => row.violation !== undefined)
    ? `\n  <label>Violations:
    <select id="violationFilter"><option value="">All</option><option value="Yes">Only violations</option></select>
  </label>`
    : "";
  return `<div class="filters">
  <label>Risk:
    <select id="riskFilter"><option value="">All</option>${optionsFor(rows.map((r) => r.risk))}</select>
  </label>
  <label>License:
    <select id="licenseFilter"><option value="">All</option>${optionsFor(rows.map((r) => r.license))}</select>
  </label>${violationFilter}
</div>`;
}

function htmlTable(rows: ReportRow[]): string {
  const columns = columnsFor(rows);
  const headerCells = columns.map((c) => `<th>${escapeHtml(headerFor(c))}</th>`).join("");
  const bodyRows = rows
    .map((row) => {
      const cells = columns.map((c) => `<td>${escapeHtml(cellValue(row, c))}</td>`).join("");
      const violationAttr = row.violation !== undefined ? ` data-violation="${row.violation ? "Yes" : "No"}"` : "";
      return `<tr data-risk="${escapeHtml(row.risk)}" data-license="${escapeHtml(row.license)}"${violationAttr}>${cells}</tr>`;
    })
    .join("\n");
  return `<table>
<thead><tr>${headerCells}</tr></thead>
<tbody>
${bodyRows}
</tbody>
</table>`;
}

/** Renders rows as a standalone HTML page, with risk/license filter dropdowns and no other dependencies. */
export function toHtmlReport(rows: ReportRow[], summary: ReportSummary): string {
  const body = `${summaryBox(summary)}
${filterDropdowns(rows)}
${htmlTable(rows)}
<script>${FILTER_SCRIPT}</script>`;
  return htmlPage(body);
}

/** Renders a `scan-workspace` report as HTML — an overall summary and one set
 * of risk/license filters at the top (applying across every repo at once),
 * then each repo as its own collapsible `<details>` section with its own
 * summary and table, so a huge multi-repo report doesn't dump every
 * component from every repo into one wall of rows. */
export function toHtmlWorkspaceReport(report: WorkspaceReport): string {
  const allRows = report.repos.flatMap((section) => section.rows);
  const sections = report.repos
    .map((section) => {
      const gateClass = section.summary.gatePassed ? "pass" : "fail";
      const gateLabel = section.summary.gatePassed ? "PASSED" : "FAILED";
      return `<details class="repo" open>
  <summary>${escapeHtml(section.repo)} <span class="gate ${gateClass}">${gateLabel}</span></summary>
  ${summaryBox(section.summary, { includeRepos: false })}
  ${htmlTable(section.rows)}
</details>`;
    })
    .join("\n");

  const body = `${summaryBox(report.overall)}
${filterDropdowns(allRows)}
${sections}
<script>${FILTER_SCRIPT}</script>`;
  return htmlPage(body);
}

/** Serializes `{ summary, components }` as JSON — `chain` is present per-row only when set. */
export function toJsonReport(rows: ReportRow[], summary: ReportSummary): string {
  return JSON.stringify({ summary, components: rows }, null, 2);
}

/** Serializes a `scan-workspace` report as `{ summary, repos: [{ repo, summary, components }] }` — the overall gate result, plus each repo's own. */
export function toJsonWorkspaceReport(report: WorkspaceReport): string {
  return JSON.stringify(
    {
      summary: report.overall,
      repos: report.repos.map((section) => ({
        repo: section.repo,
        summary: section.summary,
        components: section.rows,
      })),
    },
    null,
    2,
  );
}

/** Excel sheet names must be <=31 chars and can't contain `: \ / ? * [ ]` or repeat — sanitizes a repo name into one, disambiguating collisions with a numeric suffix. */
function sheetNameFor(repo: string, used: Set<string>): string {
  const base = repo.replace(/[:\\/?*[\]]/g, "-").slice(0, 31) || "repo";
  let name = base;
  for (let i = 2; used.has(name); i++) {
    const suffix = ` (${i})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name);
  return name;
}

function addComponentRows(sheet: ExcelJS.Worksheet, rows: ReportRow[]): void {
  const columns = columnsFor(rows);
  sheet.addRow(columns.map(headerFor));
  for (const row of rows) sheet.addRow(columns.map((c) => cellValue(row, c)));
}

function addSummaryRows(sheet: ExcelJS.Worksheet, summary: ReportSummary): void {
  sheet.addRow(["Repositories", summary.repos.join(", ")]);
  sheet.addRow(["Scanned at", summary.scannedAt]);
  sheet.addRow(["Total components", summary.totalComponents]);
  sheet.addRow(["Distinct licenses", summary.distinctLicenseCount]);
  sheet.addRow(["Compliance gate", summary.gatePassed ? "PASSED" : "FAILED"]);
  sheet.addRow(["Violations", summary.violationCount]);
}

/** Renders rows as an `.xlsx` workbook — a "Summary" sheet, then a "Notices" sheet with one row per component. */
export async function toXlsxReport(rows: ReportRow[], summary: ReportSummary): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  addSummaryRows(workbook.addWorksheet("Summary"), summary);
  addComponentRows(workbook.addWorksheet("Notices"), rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Renders a `scan-workspace` report as an `.xlsx` workbook — a "Summary"
 * sheet with the overall gate result plus a one-row-per-repo rollup table
 * (so you can see which repo failed without opening every sheet), then one
 * sheet per repo with that repo's own components. */
export async function toXlsxWorkspaceReport(report: WorkspaceReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summarySheet = workbook.addWorksheet("Summary");
  addSummaryRows(summarySheet, report.overall);
  summarySheet.addRow([]);
  summarySheet.addRow(["Repo", "Components", "Distinct Licenses", "Gate", "Violations"]);
  for (const section of report.repos) {
    summarySheet.addRow([
      section.repo,
      section.summary.totalComponents,
      section.summary.distinctLicenseCount,
      section.summary.gatePassed ? "PASSED" : "FAILED",
      section.summary.violationCount,
    ]);
  }

  const usedNames = new Set<string>();
  for (const section of report.repos) {
    const sheet = workbook.addWorksheet(sheetNameFor(section.repo, usedNames));
    sheet.addRow(["Repo", section.repo]);
    sheet.addRow(["Compliance gate", section.summary.gatePassed ? "PASSED" : "FAILED"]);
    sheet.addRow(["Violations", section.summary.violationCount]);
    sheet.addRow([]);
    addComponentRows(sheet, section.rows);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function junitTestcase(row: ReportRow): string {
  const name = `${row.name}@${row.version}`;
  if (!row.violation) return `  <testcase classname="license-compliance-gate" name="${escapeHtml(name)}" />`;
  const message = `${row.license} is ${row.risk} and violates the license policy`;
  return `  <testcase classname="license-compliance-gate" name="${escapeHtml(name)}">
    <failure message="${escapeHtml(message)}">${escapeHtml(message)}</failure>
  </testcase>`;
}

function junitTestsuite(rows: ReportRow[], suiteName: string): string {
  const failures = rows.filter((row) => row.violation).length;
  return `<testsuite name="${escapeHtml(suiteName)}" tests="${rows.length}" failures="${failures}">
${rows.map(junitTestcase).join("\n")}
</testsuite>`;
}

/** Renders rows as JUnit XML — one `<testcase>` per component, with a `<failure>` for any that violate the policy. Native in Azure DevOps (`PublishTestResults@2`); on GitHub Actions needs a marketplace action (e.g. `dorny/test-reporter`). */
export function toJunitReport(rows: ReportRow[], suiteName = "license-compliance-gate"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${junitTestsuite(rows, suiteName)}\n`;
}

/** Renders a `scan-workspace` report as JUnit XML — one `<testsuite>` per repo inside a `<testsuites>` wrapper. */
export function toJunitWorkspaceReport(report: WorkspaceReport): string {
  const suites = report.repos.map((section) => junitTestsuite(section.rows, section.repo)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites}\n</testsuites>\n`;
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
}

interface SarifResult {
  ruleId: string;
  level: "error";
  message: { text: string };
  locations: [{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }];
}

const sarifRuleId = (violation: PolicyViolation) => `${violation.reason}/${violation.license}`;

/**
 * A dependency's disallowed license has no natural source line, so every
 * finding is anchored to line 1 of `package.json` (or `<repo>/package.json`
 * in a workspace report) — a documented simplification so GitHub Code
 * Scanning / Azure DevOps SARIF viewers have somewhere to show the finding,
 * not a claim that's literally where the problem lives.
 */
function sarifResult(violation: PolicyViolation, uri: string): SarifResult {
  return {
    ruleId: sarifRuleId(violation),
    level: "error",
    message: {
      text: `${violation.component}@${violation.version ?? "?"} uses ${violation.license} (${violation.riskTier}), disallowed by policy (${violation.reason}).`,
    },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }],
  };
}

function sarifRules(violations: PolicyViolation[]): SarifRule[] {
  const rules = new Map<string, SarifRule>();
  for (const violation of violations) {
    const id = sarifRuleId(violation);
    if (!rules.has(id)) rules.set(id, { id, shortDescription: { text: `${violation.license} is disallowed (${violation.reason})` } });
  }
  return [...rules.values()];
}

function sarifLog(results: SarifResult[], violations: PolicyViolation[]): string {
  return JSON.stringify(
    {
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "license-compliance-gate", rules: sarifRules(violations) } }, results }],
    },
    null,
    2,
  );
}

/** Renders policy violations as a SARIF 2.1.0 log — GitHub Code Scanning's native format (Advanced Security required on private repos); Azure DevOps needs a marketplace SARIF viewer extension. Only violations are included: SARIF is a list of problems, not a full component inventory. */
export function toSarifReport(violations: PolicyViolation[]): string {
  return sarifLog(
    violations.map((v) => sarifResult(v, "package.json")),
    violations,
  );
}

/** Renders a `scan-workspace` report's violations as one SARIF log, each finding's location prefixed with its repo name so results from different repos don't collide on the same `package.json` uri. */
export function toSarifWorkspaceReport(results: RepoScanResult[]): string {
  const allViolations = results.flatMap((result) => result.violations);
  const sarifResults = results.flatMap((result) =>
    result.violations.map((v) => sarifResult(v, `${result.repo}/package.json`)),
  );
  return sarifLog(sarifResults, allViolations);
}

interface FormatRenderers {
  xlsx: () => Promise<Buffer>;
  md: () => string;
  html: () => string;
  json: () => string;
  junit: () => string;
  sarif: () => string;
}

/** Writes whichever renderer matches `outPath`'s file extension (`.xlsx`, `.md`, `.html`, `.xml` for JUnit, `.sarif`, or default `.json`) — shared by `writeReport` and `writeWorkspaceReport` so the two never pick a different format for the same extension. */
async function writeByExtension(outPath: string, renderers: FormatRenderers): Promise<void> {
  const ext = extname(outPath);
  if (ext === ".xlsx") await writeFile(outPath, await renderers.xlsx());
  else if (ext === ".md") await writeFile(outPath, renderers.md(), "utf8");
  else if (ext === ".html") await writeFile(outPath, renderers.html(), "utf8");
  else if (ext === ".xml") await writeFile(outPath, renderers.junit(), "utf8");
  else if (ext === ".sarif") await writeFile(outPath, renderers.sarif(), "utf8");
  else await writeFile(outPath, renderers.json(), "utf8");
}

/**
 * Writes a single-project report. Format is inferred from the file extension
 * (`.xlsx`, `.json`, `.md`, or `.html`). `chains` (from `computeDependencyChains`)
 * is optional — pass it to populate the dependency-chain column/field for any
 * non-permissive license. `options.violationsOnly` filters the displayed rows
 * down to just the ones that failed the policy (the summary still reflects
 * every scanned component, not just the filtered set).
 */
export async function writeReport(
  document: NoticesDocument,
  outPath: string,
  violations: PolicyViolation[],
  chains?: ReadonlyMap<string, string[]>,
  options: { violationsOnly?: boolean } = {},
): Promise<void> {
  const rows = toReportRows(document, chains, violations);
  const summary = buildSummary(rows, [document.project?.name ?? "project"], violations);
  const displayRows = options.violationsOnly ? filterViolationRows(rows) : rows;
  await writeByExtension(outPath, {
    xlsx: () => toXlsxReport(displayRows, summary),
    md: () => toMarkdownReport(displayRows, summary),
    html: () => toHtmlReport(displayRows, summary),
    json: () => toJsonReport(displayRows, summary),
    junit: () => toJunitReport(displayRows, document.project?.name),
    sarif: () => toSarifReport(violations),
  });
}

/** Prints a console summary grouped by risk tier — the same grouping `foss-notices-viewer list` uses. */
export function printConsoleSummary(document: NoticesDocument): void {
  const result = queryNotices(document, { groupBy: "risk", pageSize: 1000 });
  for (const group of result.groups) {
    console.log(`\n${group.key} (${group.components.length})`);
    for (const component of group.components) {
      const license = component.licenses[0]?.id ?? "UNKNOWN";
      console.log(`  ${component.name}@${component.version ?? "?"}  ${license}`);
    }
  }
  console.log(`\n${result.total} component(s) total`);
}

/**
 * Consolidated report for a multi-repo (M&A / vendor due-diligence) scan —
 * one section per repo, each with its own summary and gate result, plus one
 * overall summary rolled up across all of them. Format is inferred from the
 * file extension, same as `writeReport`. Sectioning by repo (instead of one
 * flat table with a Repo column) is deliberate: with thousands of components
 * across several repos, a flat table makes it hard to tell which repo failed
 * and why — a per-repo section with its own gate result answers that at a
 * glance.
 */
export async function writeWorkspaceReport(
  results: RepoScanResult[],
  outPath: string,
  options: { violationsOnly?: boolean } = {},
): Promise<void> {
  const report = buildWorkspaceReport(results, options);
  await writeByExtension(outPath, {
    xlsx: () => toXlsxWorkspaceReport(report),
    md: () => toMarkdownWorkspaceReport(report),
    html: () => toHtmlWorkspaceReport(report),
    json: () => toJsonWorkspaceReport(report),
    junit: () => toJunitWorkspaceReport(report),
    sarif: () => toSarifWorkspaceReport(results),
  });
}
