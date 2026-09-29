import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyComponentRisk } from "foss-notices-viewer";
import type { NoticesDocument } from "foss-notices-viewer";
import { DEFAULT_POLICY, type PolicyConfig, type PolicyViolation } from "./types.js";

export const DEFAULT_POLICY_FILENAME = "compliance.config.json";

/**
 * Resolves which policy file applies to `dir`: an explicit `--policy` path always wins;
 * otherwise falls back to `compliance.config.json` inside `dir` if one exists. Shared by
 * every command that scans a directory (`scan`, `scan-workspace`) so a repo's own policy
 * file is never silently ignored by one command but not another.
 */
export function resolvePolicyPath(dir: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const implicit = join(dir, DEFAULT_POLICY_FILENAME);
  return existsSync(implicit) ? implicit : undefined;
}

const POLICY_KEYS = new Set<keyof PolicyConfig>(["disallowedLicenses", "disallowedRiskTiers", "licenseRiskMap"]);

/**
 * Rejects a config with an unknown top-level key (most likely a typo, e.g.
 * `disallowedRiskTier` missing its `s`) instead of silently ignoring it and
 * falling back to the default — a policy file that looks customized but
 * silently isn't is worse than one that fails to load at all.
 */
function validatePolicyShape(raw: Record<string, unknown>, path: string): void {
  const unknownKeys = Object.keys(raw).filter((key) => !POLICY_KEYS.has(key as keyof PolicyConfig));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${path}: unknown key(s) ${unknownKeys.map((k) => `"${k}"`).join(", ")} — expected only ${[...POLICY_KEYS].join(", ")}`,
    );
  }
  if (raw.disallowedLicenses !== undefined && !Array.isArray(raw.disallowedLicenses)) {
    throw new Error(`${path}: "disallowedLicenses" must be an array of strings`);
  }
  if (raw.disallowedRiskTiers !== undefined && !Array.isArray(raw.disallowedRiskTiers)) {
    throw new Error(`${path}: "disallowedRiskTiers" must be an array of strings`);
  }
  if (raw.licenseRiskMap !== undefined && (typeof raw.licenseRiskMap !== "object" || Array.isArray(raw.licenseRiskMap))) {
    throw new Error(`${path}: "licenseRiskMap" must be an object`);
  }
}

/** Loads a policy config file, falling back to `DEFAULT_POLICY` for any field it omits. Throws if the file has an unknown key or a field of the wrong type — see `validatePolicyShape`. */
export async function loadPolicyConfig(path?: string): Promise<PolicyConfig> {
  if (!path) return DEFAULT_POLICY;
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<PolicyConfig>;
  validatePolicyShape(raw, path);
  return {
    disallowedLicenses: raw.disallowedLicenses ?? DEFAULT_POLICY.disallowedLicenses,
    disallowedRiskTiers: raw.disallowedRiskTiers ?? DEFAULT_POLICY.disallowedRiskTiers,
    licenseRiskMap: raw.licenseRiskMap ?? DEFAULT_POLICY.licenseRiskMap,
  };
}

/** Walks every component and reports each one that violates the given policy. */
export function evaluatePolicy(
  document: NoticesDocument,
  policy: PolicyConfig,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  for (const component of document.components) {
    const riskTier = classifyComponentRisk(component, policy.licenseRiskMap);
    const licenseId = component.licenses[0]?.id ?? "UNKNOWN";

    const disallowedLicense = component.licenses.find((license) =>
      policy.disallowedLicenses.includes(license.id),
    );
    if (disallowedLicense) {
      violations.push({
        component: component.name,
        version: component.version,
        license: disallowedLicense.id,
        riskTier,
        reason: "disallowed-license",
      });
      continue;
    }

    if (policy.disallowedRiskTiers.includes(riskTier)) {
      violations.push({
        component: component.name,
        version: component.version,
        license: licenseId,
        riskTier,
        reason: "disallowed-risk-tier",
      });
    }
  }

  return violations;
}
