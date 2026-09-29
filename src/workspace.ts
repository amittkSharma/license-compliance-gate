import { basename, resolve } from "node:path";
import { scanWithSource } from "./scan.js";
import { evaluatePolicy, loadPolicyConfig, resolvePolicyPath } from "./policy.js";
import type { RepoScanResult, ScanSource } from "./types.js";

/**
 * Scans each directory in turn. `explicitPolicyPath` (from `--policy`), if given, applies to
 * every repo; otherwise each repo's own `compliance.config.json` is used when present, falling
 * back to `DEFAULT_POLICY` — the same per-repo resolution `scan` uses, so a repo scanned on its
 * own and a repo scanned as part of a workspace are gated identically. `source` applies to
 * every repo the same way (see `scanWithSource`).
 */
export async function scanWorkspace(
  dirs: string[],
  explicitPolicyPath?: string,
  source: ScanSource = "node_modules",
): Promise<RepoScanResult[]> {
  const results: RepoScanResult[] = [];
  for (const dir of dirs) {
    const policy = await loadPolicyConfig(resolvePolicyPath(dir, explicitPolicyPath));
    const { document, chains } = await scanWithSource(dir, source);
    const violations = evaluatePolicy(document, policy);
    results.push({ repo: document.project?.name ?? basename(resolve(dir)), document, violations, chains });
  }
  return results;
}
