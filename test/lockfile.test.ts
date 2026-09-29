import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackageLock, scanLockfile } from "../src/lockfile.js";

function writeLockfile(dir: string, lock: unknown): void {
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "compliance-gate-lockfile-"));
}

const SAMPLE_LOCK = {
  name: "root-app",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "root-app",
      version: "1.0.0",
      dependencies: { "left-pad": "^1.0.0" },
      devDependencies: { "eslint": "^8.0.0" },
    },
    "node_modules/left-pad": {
      version: "1.3.0",
      license: "MIT",
      dependencies: { "@scope/inner": "^2.0.0" },
    },
    "node_modules/@scope/inner": {
      version: "2.0.0",
      license: "ISC",
    },
    "node_modules/eslint": {
      version: "8.57.0",
      license: "MIT",
    },
    "node_modules/buffers": {
      version: "0.1.1",
    },
  },
};

test("readPackageLock rejects a missing file", async () => {
  await assert.rejects(() => readPackageLock(tmpDir()), /No package-lock\.json found/);
});

test("readPackageLock rejects a lockfileVersion < 2", async () => {
  const dir = tmpDir();
  writeLockfile(dir, { lockfileVersion: 1 });
  await assert.rejects(() => readPackageLock(dir), /needs an npm v7\+ lockfile/);
});

test("readPackageLock rejects a lockfile with no packages map", async () => {
  const dir = tmpDir();
  writeLockfile(dir, { lockfileVersion: 3 });
  await assert.rejects(() => readPackageLock(dir), /needs an npm v7\+ lockfile/);
});

test("readPackageLock accepts a valid v3 lockfile", async () => {
  const dir = tmpDir();
  writeLockfile(dir, SAMPLE_LOCK);
  const lock = await readPackageLock(dir);
  assert.equal(lock.name, "root-app");
});

test("scanLockfile builds components with name, version, license, and direct-vs-transitive", async () => {
  const dir = tmpDir();
  writeLockfile(dir, SAMPLE_LOCK);
  const { document } = await scanLockfile(dir);

  const byName = new Map(document.components.map((c) => [c.name, c]));
  assert.equal(byName.get("left-pad")?.version, "1.3.0");
  assert.equal(byName.get("left-pad")?.licenses[0]?.id, "MIT");
  assert.equal(byName.get("left-pad")?.dependencyType, "direct");
  assert.equal(byName.get("eslint")?.dependencyType, "direct");
  assert.equal(byName.get("@scope/inner")?.dependencyType, "transitive");
  assert.equal(byName.get("@scope/inner")?.licenses[0]?.id, "ISC");
});

test("scanLockfile falls back to UNKNOWN for a package with no license field", async () => {
  const dir = tmpDir();
  writeLockfile(dir, SAMPLE_LOCK);
  const { document } = await scanLockfile(dir);
  const buffers = document.components.find((c) => c.name === "buffers");
  assert.equal(buffers?.licenses[0]?.id, "UNKNOWN");
});

test("scanLockfile reconstructs dependency chains by walking the lockfile's own dependencies edges", async () => {
  const dir = tmpDir();
  writeLockfile(dir, SAMPLE_LOCK);
  const { chains } = await scanLockfile(dir);

  assert.deepEqual(chains.get("left-pad@1.3.0"), ["root-app", "left-pad"]);
  assert.deepEqual(chains.get("@scope/inner@2.0.0"), ["root-app", "left-pad", "@scope/inner"]);
  assert.deepEqual(chains.get("eslint@8.57.0"), ["root-app", "eslint"]);
});
