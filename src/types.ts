import type { NoticesDocument, RiskTier } from "foss-notices-viewer";

/** Where a scan reads its dependency data from. `"node_modules"` (default) needs a real install and gives the fullest picture (npm/yarn/pnpm, workspaces). `"lockfile"` reads only a committed npm `package-lock.json` — no install required, but npm-only and no workspace merging. */
export type ScanSource = "node_modules" | "lockfile";

/** User-configurable license policy, loaded from `compliance.config.json` (or `--policy <path>`). */
export interface PolicyConfig {
  /** Exact SPDX ids to always block, regardless of risk tier (e.g. a license legal has specifically rejected). */
  disallowedLicenses: string[];
  /** Risk tiers that fail the gate. Defaults to `["copyleft"]` — "unknown" is left out of the default so an unclassifiable license warns rather than blocks releases by default. */
  disallowedRiskTiers: RiskTier[];
  /** Passed straight through to foss-notices-viewer's risk classifier — same shape as its `licenseRiskMap` prop/option. */
  licenseRiskMap: Record<string, RiskTier>;
}

export const DEFAULT_POLICY: PolicyConfig = {
  disallowedLicenses: [],
  disallowedRiskTiers: ["copyleft"],
  licenseRiskMap: {},
};

export interface PolicyViolation {
  component: string;
  version?: string;
  license: string;
  riskTier: RiskTier;
  reason: "disallowed-license" | "disallowed-risk-tier";
}

/** One repo's scan result, used both for a single-project gate and as an element of a workspace-wide scan. */
export interface RepoScanResult {
  repo: string;
  document: NoticesDocument;
  violations: PolicyViolation[];
  /** `name@version` -> dependency chain from `computeDependencyChains`, used to explain non-permissive licenses in reports. */
  chains: Map<string, string[]>;
}
