import { Command } from "commander";
import { diffNotices } from "foss-notices-viewer";
import { scanDirectory, scanWithSource } from "./scan.js";
import { scanWorkspace } from "./workspace.js";
import { evaluatePolicy, loadPolicyConfig, resolvePolicyPath } from "./policy.js";
import { DEFAULT_BASELINE_PATH, loadBaseline, saveBaseline } from "./baseline.js";
import { printConsoleSummary, writeReport, writeWorkspaceReport } from "./report.js";
import type { PolicyViolation, ScanSource } from "./types.js";

function parseSource(value: string): ScanSource {
  if (value !== "node_modules" && value !== "lockfile") {
    throw new Error(`--source must be "node_modules" or "lockfile", got "${value}"`);
  }
  return value;
}

function printViolations(violations: PolicyViolation[]): void {
  if (violations.length === 0) {
    console.log("\nNo policy violations.");
    return;
  }
  console.log(`\n${violations.length} policy violation(s):`);
  for (const violation of violations) {
    console.log(
      `  ${violation.component}@${violation.version ?? "?"}  ${violation.license}  [${violation.riskTier}]  (${violation.reason})`,
    );
  }
}

const program = new Command();

program
  .name("compliance-gate")
  .description(
    "License compliance gate for Node projects — scans with license-checker, evaluates a policy, and reports with foss-notices-viewer.",
  );

program
  .command("scan")
  .description("Scan a project and fail if any dependency violates the license policy (release gate).")
  .argument("[dir]", "project directory", ".")
  .option("-p, --policy <path>", "policy config file (default: compliance.config.json in <dir> if present)")
  .option("-o, --out <path>", "write a report to this path (.json, .xlsx, .md, .html, .sarif, or .xml for JUnit)")
  .option("--violations-only", "report only components that fail the policy, not every scanned component", false)
  .option(
    "--source <source>",
    'where to read dependency data from: "node_modules" (default, needs a real install) or "lockfile" (npm package-lock.json only, no install required)',
    parseSource,
    "node_modules",
  )
  .option("--no-fail", "always exit 0, even on violations")
  .action(
    async (
      dir: string,
      options: { policy?: string; out?: string; violationsOnly: boolean; source: ScanSource; fail: boolean },
    ) => {
      const policy = await loadPolicyConfig(resolvePolicyPath(dir, options.policy));
      const { document, chains } = await scanWithSource(dir, options.source);
      const violations = evaluatePolicy(document, policy);

      printConsoleSummary(document);
      printViolations(violations);
      if (options.out) {
        await writeReport(document, options.out, violations, chains, { violationsOnly: options.violationsOnly });
      }

      if (violations.length > 0 && options.fail) process.exitCode = 1;
    },
  );

program
  .command("drift")
  .description("Diff the current dependency tree against a saved baseline (license drift detection).")
  .argument("[dir]", "project directory", ".")
  .option("-b, --baseline <path>", "baseline file", DEFAULT_BASELINE_PATH)
  .option("--fail-on-change", "exit 1 if anything was added, removed, or changed", false)
  .option("--update-baseline", "save the current scan as the new baseline after diffing", false)
  .action(
    async (
      dir: string,
      options: { baseline: string; failOnChange: boolean; updateBaseline: boolean },
    ) => {
      const current = await scanDirectory(dir);
      const baseline = await loadBaseline(options.baseline);

      if (!baseline) {
        await saveBaseline(options.baseline, current);
        console.log(`No baseline found at ${options.baseline} — current scan saved as the baseline.`);
        return;
      }

      const diff = diffNotices(baseline, current);
      console.log(`Added (${diff.added.length}):`);
      for (const c of diff.added) console.log(`  + ${c.name}@${c.version ?? "?"}`);
      console.log(`Removed (${diff.removed.length}):`);
      for (const c of diff.removed) console.log(`  - ${c.name}@${c.version ?? "?"}`);
      console.log(`Changed (${diff.changed.length}):`);
      for (const c of diff.changed) {
        const licenseNote = c.licensesChanged ? " (license changed)" : "";
        console.log(`  ~ ${c.name}: ${c.before.version ?? "?"} -> ${c.after.version ?? "?"}${licenseNote}`);
      }

      if (options.updateBaseline) await saveBaseline(options.baseline, current);

      const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
      if (hasChanges && options.failOnChange) process.exitCode = 1;
    },
  );

program
  .command("scan-workspace")
  .description("Scan multiple repos and produce one consolidated report (M&A / vendor due diligence).")
  .argument("<dirs...>", "project directories")
  .option(
    "-p, --policy <path>",
    "policy config file, applied to every repo (default: each repo's own compliance.config.json if present)",
  )
  .option(
    "-o, --out <path>",
    "write the consolidated report to this path (.json, .xlsx, .md, .html, .sarif, or .xml for JUnit)",
    "consolidated-report.json",
  )
  .option("--violations-only", "report only components that fail the policy, not every scanned component", false)
  .option(
    "--source <source>",
    'where to read dependency data from: "node_modules" (default, needs a real install) or "lockfile" (npm package-lock.json only, no install required)',
    parseSource,
    "node_modules",
  )
  .action(async (dirs: string[], options: { policy?: string; out: string; violationsOnly: boolean; source: ScanSource }) => {
    const results = await scanWorkspace(dirs, options.policy, options.source);

    for (const result of results) {
      console.log(`\n${result.repo}: ${result.document.components.length} component(s), ${result.violations.length} violation(s)`);
      printViolations(result.violations);
    }

    await writeWorkspaceReport(results, options.out, { violationsOnly: options.violationsOnly });
    console.log(`\nConsolidated report written to ${options.out}`);

    if (results.some((result) => result.violations.length > 0)) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
