import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NoticesDocument } from "foss-notices-viewer";
import { evaluatePolicy, loadPolicyConfig, resolvePolicyPath } from "../src/policy.js";
import { DEFAULT_POLICY } from "../src/types.js";

function documentWith(licenseId: string, name = "some-package"): NoticesDocument {
  return {
    source: "unknown",
    components: [
      {
        name,
        version: "1.0.0",
        licenses: [{ id: licenseId, name: licenseId }],
        copyrights: [],
      },
    ],
  };
}

test("flags a copyleft license under the default policy", () => {
  const violations = evaluatePolicy(documentWith("GPL-3.0-only"), DEFAULT_POLICY);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.reason, "disallowed-risk-tier");
  assert.equal(violations[0]?.riskTier, "copyleft");
});

test("does not flag a permissive license under the default policy", () => {
  const violations = evaluatePolicy(documentWith("MIT"), DEFAULT_POLICY);
  assert.equal(violations.length, 0);
});

test("flags an explicitly disallowed license even if its risk tier would pass", () => {
  const violations = evaluatePolicy(documentWith("Some-Internal-License-1.0"), {
    ...DEFAULT_POLICY,
    disallowedLicenses: ["Some-Internal-License-1.0"],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.reason, "disallowed-license");
});

test("a custom risk map can make an otherwise-permissive license fail", () => {
  const violations = evaluatePolicy(documentWith("Some-Internal-License-1.0"), {
    ...DEFAULT_POLICY,
    licenseRiskMap: { "Some-Internal-License-1.0": "proprietary" },
    disallowedRiskTiers: ["copyleft", "proprietary"],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.riskTier, "proprietary");
});

test("resolvePolicyPath prefers an explicit path over the repo's own config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "compliance-gate-"));
  writeFileSync(join(dir, "compliance.config.json"), "{}");
  assert.equal(resolvePolicyPath(dir, "/explicit/path.json"), "/explicit/path.json");
});

test("resolvePolicyPath falls back to <dir>/compliance.config.json when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "compliance-gate-"));
  writeFileSync(join(dir, "compliance.config.json"), "{}");
  assert.equal(resolvePolicyPath(dir), join(dir, "compliance.config.json"));
});

test("loadPolicyConfig rejects a typo'd key instead of silently falling back to the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "compliance-gate-"));
  const path = join(dir, "compliance.config.json");
  writeFileSync(path, JSON.stringify({ disallowedRiskTier: ["copyleft"] }));
  await assert.rejects(() => loadPolicyConfig(path), /unknown key\(s\) "disallowedRiskTier"/);
});

test("loadPolicyConfig rejects a field of the wrong type", async () => {
  const dir = mkdtempSync(join(tmpdir(), "compliance-gate-"));
  const path = join(dir, "compliance.config.json");
  writeFileSync(path, JSON.stringify({ disallowedLicenses: "GPL-3.0" }));
  await assert.rejects(() => loadPolicyConfig(path), /"disallowedLicenses" must be an array/);
});

test("loadPolicyConfig accepts a valid config with only known keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "compliance-gate-"));
  const path = join(dir, "compliance.config.json");
  writeFileSync(path, JSON.stringify({ disallowedRiskTiers: ["copyleft", "proprietary"] }));
  const policy = await loadPolicyConfig(path);
  assert.deepEqual(policy.disallowedRiskTiers, ["copyleft", "proprietary"]);
  assert.deepEqual(policy.disallowedLicenses, []);
});

test("resolvePolicyPath returns undefined when neither an explicit path nor a repo config file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "compliance-gate-"));
  assert.equal(resolvePolicyPath(dir), undefined);
});
