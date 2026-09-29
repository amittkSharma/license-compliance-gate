export { scanDirectory, computeDependencyChains, scanWithSource } from "./scan.js";
export { scanLockfile } from "./lockfile.js";
export { scanWorkspace } from "./workspace.js";
export { evaluatePolicy, loadPolicyConfig, resolvePolicyPath } from "./policy.js";
export { loadBaseline, saveBaseline, DEFAULT_BASELINE_PATH } from "./baseline.js";
export {
  writeReport,
  writeWorkspaceReport,
  printConsoleSummary,
  toJunitReport,
  toJunitWorkspaceReport,
  toSarifReport,
  toSarifWorkspaceReport,
} from "./report.js";
export { parseLicenseCheckerOutput } from "./adapters/licenseChecker.js";
export {
  DEFAULT_POLICY,
  type PolicyConfig,
  type PolicyViolation,
  type RepoScanResult,
  type ScanSource,
} from "./types.js";
