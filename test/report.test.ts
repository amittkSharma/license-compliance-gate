import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import type { NoticesDocument } from "foss-notices-viewer";
import type { PolicyViolation, RepoScanResult } from "../src/types.js";
import {
  toReportRows,
  buildSummary,
  buildWorkspaceReport,
  filterViolationRows,
  toMarkdownReport,
  toMarkdownWorkspaceReport,
  toHtmlReport,
  toHtmlWorkspaceReport,
  toJsonReport,
  toJsonWorkspaceReport,
  toXlsxReport,
  toXlsxWorkspaceReport,
  toJunitReport,
  toJunitWorkspaceReport,
  toSarifReport,
  toSarifWorkspaceReport,
} from "../src/report.js";

const document: NoticesDocument = {
  source: "unknown",
  components: [
    {
      name: "left-pad",
      version: "1.3.0",
      licenses: [{ id: "MIT", name: "MIT" }],
      copyrights: [],
    },
  ],
};

const copyleftDocument: NoticesDocument = {
  source: "unknown",
  components: [
    { name: "gpl-thing", version: "2.0.0", licenses: [{ id: "GPL-3.0", name: "GPL-3.0" }], copyrights: [] },
  ],
};

const noViolations: PolicyViolation[] = [];
const copyleftViolation: PolicyViolation = {
  component: "gpl-thing",
  version: "2.0.0",
  license: "GPL-3.0",
  riskTier: "copyleft",
  reason: "disallowed-risk-tier",
};

test("toReportRows attaches a dependency chain only for non-permissive rows with a known chain", () => {
  const chains = new Map([["left-pad@1.3.0", ["root", "left-pad"]]]);
  const permissiveRows = toReportRows(document, chains);
  assert.equal(permissiveRows[0]?.chain, undefined, "MIT is permissive, so no chain is attached");

  const copyleftChains = new Map([["gpl-thing@2.0.0", ["root", "mid", "gpl-thing"]]]);
  const rows = toReportRows(copyleftDocument, copyleftChains);
  assert.equal(rows[0]?.chain, "root > mid > gpl-thing");
});

test("toReportRows marks a row `violation: true` only when it matches a real PolicyViolation", () => {
  const rows = toReportRows(copyleftDocument, undefined, [copyleftViolation]);
  assert.equal(rows[0]?.violation, true);

  const clean = toReportRows(document, undefined, []);
  assert.equal(clean[0]?.violation, undefined);
});

test("filterViolationRows keeps only rows flagged as violations", () => {
  const rows = toReportRows(copyleftDocument, undefined, [copyleftViolation]);
  const permissiveRows = toReportRows(document, undefined, []);
  assert.equal(filterViolationRows([...rows, ...permissiveRows]).length, 1);
  assert.equal(filterViolationRows(permissiveRows).length, 0);
});

test("buildSummary reports total components, distinct licenses, and gate status", () => {
  const rows = toReportRows(document);
  const passing = buildSummary(rows, ["repo-a"], noViolations);
  assert.equal(passing.totalComponents, 1);
  assert.equal(passing.distinctLicenseCount, 1);
  assert.equal(passing.gatePassed, true);
  assert.equal(passing.violationCount, 0);
  assert.ok(passing.scannedAt.length > 0);

  const failing = buildSummary(rows, ["repo-a"], [copyleftViolation]);
  assert.equal(failing.gatePassed, false);
  assert.equal(failing.violationCount, 1);
});

test("markdown: summary section, then a table", () => {
  const rows = toReportRows(document);
  const markdown = toMarkdownReport(rows, buildSummary(rows, ["repo-a"], noViolations));
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /Total components: 1/);
  assert.match(markdown, /Compliance gate: PASSED/);
  assert.match(markdown, /## Components/);
  const tableLines = markdown.split("## Components\n\n")[1]?.trim().split("\n") ?? [];
  assert.equal(tableLines.length, 3);
  assert.match(tableLines[2] ?? "", /left-pad.*1\.3\.0.*MIT/);
});

test("markdown: escapes pipe characters so they don't break the table grid", () => {
  const doc = { ...document, components: [{ ...document.components[0]!, name: "weird|name" }] };
  const rows = toReportRows(doc);
  assert.match(toMarkdownReport(rows, buildSummary(rows, ["repo-a"], noViolations)), /weird\\\|name/);
});

test("html: renders a summary box, filter dropdowns, and a table with an escaped cell", () => {
  const doc = { ...document, components: [{ ...document.components[0]!, name: "<script>" }] };
  const rows = toReportRows(doc);
  const html = toHtmlReport(rows, buildSummary(rows, ["repo-a"], noViolations));
  assert.match(html, /<table>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<td><script><\/td>/);
  assert.match(html, /id="riskFilter"/);
  assert.match(html, /id="licenseFilter"/);
  assert.match(html, /data-risk="/);
  assert.match(html, /Compliance gate:/);
});

test("html: adds a Violation column, data-violation attribute, and a violations filter only when violations were evaluated", () => {
  const rows = toReportRows(copyleftDocument, undefined, [copyleftViolation]);
  const html = toHtmlReport(rows, buildSummary(rows, ["repo-a"], [copyleftViolation]));
  assert.match(html, /<th>Violation<\/th>/);
  assert.match(html, /data-violation="Yes"/);
  assert.match(html, /id="violationFilter"/);

  const cleanRows = toReportRows(document);
  const cleanHtml = toHtmlReport(cleanRows, buildSummary(cleanRows, ["repo-a"], noViolations));
  assert.doesNotMatch(cleanHtml, /id="violationFilter"/);
});

test("markdown: renders a Violation column when rows were evaluated against a policy", () => {
  const rows = toReportRows(copyleftDocument, undefined, [copyleftViolation]);
  const markdown = toMarkdownReport(rows, buildSummary(rows, ["repo-a"], [copyleftViolation]));
  assert.match(markdown, /\| Violation \|/);
  assert.match(markdown, /gpl-thing.*\| Yes \|/);
});

test("json: wraps rows in { summary, components }", () => {
  const rows = toReportRows(document);
  const single = JSON.parse(toJsonReport(rows, buildSummary(rows, ["repo-a"], noViolations)));
  assert.equal(single.components[0].name, "left-pad");
  assert.equal(single.summary.totalComponents, 1);
});

test("xlsx: produces a workbook with Summary and Notices sheets and a header row", async () => {
  const rows = toReportRows(document);
  const buffer = await toXlsxReport(rows, buildSummary(rows, ["repo-a"], noViolations));
  const workbook = new ExcelJS.Workbook();
  // exceljs types `load` against its own module-local `Buffer` (extends `ArrayBuffer`), not Node's `Buffer`.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const summarySheet = workbook.getWorksheet("Summary");
  assert.ok(summarySheet);
  assert.equal(summarySheet?.getRow(1).getCell(1).value, "Repositories");

  const sheet = workbook.getWorksheet("Notices");
  assert.ok(sheet);
  assert.equal(sheet?.getRow(1).getCell(1).value, "Package Name");
  assert.equal(sheet?.getRow(2).getCell(1).value, "left-pad");
});

function makeResult(repo: string, document: NoticesDocument, violations: PolicyViolation[]): RepoScanResult {
  return { repo, document, violations, chains: new Map() };
}

test("buildWorkspaceReport: one section per repo, plus an overall summary rolled up across all of them", () => {
  const results = [
    makeResult("repo-a", document, noViolations),
    makeResult("repo-b", copyleftDocument, [copyleftViolation]),
  ];
  const report = buildWorkspaceReport(results);

  assert.equal(report.overall.totalComponents, 2);
  assert.equal(report.overall.violationCount, 1);
  assert.equal(report.overall.gatePassed, false);
  assert.deepEqual(report.overall.repos, ["repo-a", "repo-b"]);

  assert.equal(report.repos.length, 2);
  assert.equal(report.repos[0]?.repo, "repo-a");
  assert.equal(report.repos[0]?.summary.gatePassed, true);
  assert.equal(report.repos[0]?.rows[0]?.name, "left-pad");
  assert.equal(report.repos[1]?.repo, "repo-b");
  assert.equal(report.repos[1]?.summary.gatePassed, false);
  assert.equal(report.repos[1]?.rows[0]?.name, "gpl-thing");
});

test("buildWorkspaceReport: violationsOnly filters displayed rows per repo but keeps the overall summary full", () => {
  const results = [
    makeResult("repo-a", document, noViolations),
    makeResult("repo-b", copyleftDocument, [copyleftViolation]),
  ];
  const report = buildWorkspaceReport(results, { violationsOnly: true });

  assert.equal(report.overall.totalComponents, 2, "overall summary still reflects every scanned component");
  assert.equal(report.repos[0]?.rows.length, 0, "repo-a has no violations, so no rows are shown");
  assert.equal(report.repos[0]?.summary.totalComponents, 1, "per-repo summary is also unfiltered");
  assert.equal(report.repos[1]?.rows.length, 1);
  assert.equal(report.repos[1]?.rows[0]?.name, "gpl-thing");
});

test("markdown workspace report: an overall summary, then one heading + table per repo", () => {
  const report = buildWorkspaceReport([
    makeResult("repo-a", document, noViolations),
    makeResult("repo-b", copyleftDocument, [copyleftViolation]),
  ]);
  const markdown = toMarkdownWorkspaceReport(report);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /Compliance gate: FAILED \(1 violation\(s\)\)/);
  assert.match(markdown, /## repo-a/);
  assert.match(markdown, /## repo-b/);
  // repo-a's own section reports its own (passing) gate, not the overall failing one.
  const repoASection = markdown.split("## repo-a")[1]?.split("## repo-b")[0] ?? "";
  assert.match(repoASection, /Compliance gate: PASSED/);
  assert.match(repoASection, /left-pad/);
});

test("html workspace report: a collapsible <details> section per repo, each with its own gate status", () => {
  const report = buildWorkspaceReport([
    makeResult("repo-a", document, noViolations),
    makeResult("repo-b", copyleftDocument, [copyleftViolation]),
  ]);
  const html = toHtmlWorkspaceReport(report);
  assert.match(html, /<details class="repo" open>/);
  const detailsCount = html.match(/<details class="repo"/g)?.length ?? 0;
  assert.equal(detailsCount, 2);
  assert.match(html, /<summary>repo-a <span class="gate pass">PASSED<\/span><\/summary>/);
  assert.match(html, /<summary>repo-b <span class="gate fail">FAILED<\/span><\/summary>/);
  assert.match(html, /id="riskFilter"/);
});

test("json workspace report: { summary, repos: [{ repo, summary, components }] }", () => {
  const report = buildWorkspaceReport([
    makeResult("repo-a", document, noViolations),
    makeResult("repo-b", copyleftDocument, [copyleftViolation]),
  ]);
  const parsed = JSON.parse(toJsonWorkspaceReport(report));
  assert.equal(parsed.summary.totalComponents, 2);
  assert.equal(parsed.repos.length, 2);
  assert.equal(parsed.repos[0].repo, "repo-a");
  assert.equal(parsed.repos[0].summary.gatePassed, true);
  assert.equal(parsed.repos[0].components[0].name, "left-pad");
  assert.equal(parsed.repos[1].summary.gatePassed, false);
});

test("xlsx workspace report: a Summary sheet with a per-repo rollup, plus one sheet per repo", async () => {
  const report = buildWorkspaceReport([
    makeResult("repo-a", document, noViolations),
    makeResult("repo-b", copyleftDocument, [copyleftViolation]),
  ]);
  const buffer = await toXlsxWorkspaceReport(report);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  assert.ok(workbook.getWorksheet("Summary"));
  const repoASheet = workbook.getWorksheet("repo-a");
  const repoBSheet = workbook.getWorksheet("repo-b");
  assert.ok(repoASheet);
  assert.ok(repoBSheet);
  assert.equal(repoASheet?.getRow(1).getCell(1).value, "Repo");
  assert.equal(repoASheet?.getRow(2).getCell(2).value, "PASSED");
  assert.equal(repoBSheet?.getRow(2).getCell(2).value, "FAILED");
});

test("toJunitReport: a <testcase> per row, <failure> only for violations", () => {
  const rows = toReportRows(copyleftDocument, undefined, [copyleftViolation]);
  const xml = toJunitReport(rows, "my-project");

  assert.match(xml, /<testsuite name="my-project" tests="1" failures="1">/);
  assert.match(xml, /<testcase classname="license-compliance-gate" name="gpl-thing@2\.0\.0">/);
  assert.match(xml, /<failure message="GPL-3\.0 is Copyleft and violates the license policy">/);
});

test("toJunitReport: a clean row gets a self-closing <testcase>, no <failure>", () => {
  const rows = toReportRows(document, undefined, []);
  const xml = toJunitReport(rows);

  assert.match(xml, /tests="1" failures="0"/);
  assert.match(xml, /<testcase classname="license-compliance-gate" name="left-pad@1\.3\.0" \/>/);
  assert.doesNotMatch(xml, /<failure/);
});

test("toJunitWorkspaceReport: one <testsuite> per repo inside <testsuites>", () => {
  const report = buildWorkspaceReport([
    makeResult("repo-a", document, noViolations),
    makeResult("repo-b", copyleftDocument, [copyleftViolation]),
  ]);
  const xml = toJunitWorkspaceReport(report);

  assert.match(xml, /<testsuites>/);
  assert.match(xml, /<testsuite name="repo-a" tests="1" failures="0">/);
  assert.match(xml, /<testsuite name="repo-b" tests="1" failures="1">/);
});

test("toSarifReport: only violations become results, each pointing at package.json", () => {
  const sarif = JSON.parse(toSarifReport([copyleftViolation])) as {
    runs: [{ tool: { driver: { rules: { id: string }[] } }; results: { ruleId: string; locations: unknown[] }[] }];
  };

  const run = sarif.runs[0];
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0]?.ruleId, "disallowed-risk-tier/GPL-3.0");
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ["disallowed-risk-tier/GPL-3.0"]);
  assert.equal(
    (run.results[0]?.locations[0] as { physicalLocation: { artifactLocation: { uri: string } } }).physicalLocation
      .artifactLocation.uri,
    "package.json",
  );
});

test("toSarifReport: a clean scan produces an empty results array, not an error", () => {
  const sarif = JSON.parse(toSarifReport([])) as { runs: [{ results: unknown[] }] };
  assert.deepEqual(sarif.runs[0]?.results, []);
});

test("toSarifWorkspaceReport: prefixes each finding's location with its own repo name", () => {
  const results = [makeResult("repo-a", document, noViolations), makeResult("repo-b", copyleftDocument, [copyleftViolation])];
  const sarif = JSON.parse(toSarifWorkspaceReport(results)) as {
    runs: [{ results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }];
  };

  assert.equal(sarif.runs[0]?.results.length, 1);
  assert.equal(sarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri, "repo-b/package.json");
});
