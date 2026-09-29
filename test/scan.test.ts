import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceDirs, collectDirectDependencyNames, parsePnpmWorkspaceYaml } from "../src/scan.js";

function makeWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "workspace-fixture-"));
  mkdirSync(join(root, "packages", "pkg-a"), { recursive: true });
  mkdirSync(join(root, "packages", "pkg-b"), { recursive: true });
  mkdirSync(join(root, "tools", "cli"), { recursive: true });
  writeFileSync(join(root, "packages", "pkg-a", "package.json"), "{}");
  writeFileSync(join(root, "packages", "pkg-b", "package.json"), "{}");
  writeFileSync(join(root, "tools", "cli", "package.json"), "{}");
  return root;
}

test("resolves a trailing /* pattern to every subdirectory", async () => {
  const root = makeWorkspaceFixture();
  try {
    const dirs = await resolveWorkspaceDirs(root, ["packages/*"]);
    assert.deepEqual(
      dirs.map((d) => d.split("/").slice(-2).join("/")).sort(),
      ["packages/pkg-a", "packages/pkg-b"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves an exact path pattern with no wildcard", async () => {
  const root = makeWorkspaceFixture();
  try {
    const dirs = await resolveWorkspaceDirs(root, ["tools/cli"]);
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0]?.endsWith("tools/cli"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips an unsupported glob pattern instead of silently mismatching it", async () => {
  const root = makeWorkspaceFixture();
  try {
    const dirs = await resolveWorkspaceDirs(root, ["packages/**", "tools/cli"]);
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0]?.endsWith("tools/cli"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns an empty list for a workspace directory that doesn't exist", async () => {
  const root = makeWorkspaceFixture();
  try {
    const dirs = await resolveWorkspaceDirs(root, ["apps/*"]);
    assert.deepEqual(dirs, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collects direct dependency names from the root and every workspace package", () => {
  const names = collectDirectDependencyNames(
    { dependencies: { "root-dep": "1.0.0" } },
    [
      { dependencies: { "is-odd": "3.0.1" } },
      { devDependencies: { "is-even": "1.0.0" } },
      undefined,
    ],
  );
  assert.deepEqual([...names].sort(), ["is-even", "is-odd", "root-dep"]);
});

test("a workspace-declared dependency the root package.json never mentions is still direct", () => {
  const names = collectDirectDependencyNames(
    { dependencies: {} },
    [{ dependencies: { "is-odd": "3.0.1" } }],
  );
  assert.ok(names.has("is-odd"));
});

test("parses a pnpm-workspace.yaml packages block-list, stripping quotes", () => {
  const yaml = `packages:\n  - 'packages/*'\n  - "apps/*"\n  - tools/cli\n`;
  assert.deepEqual(parsePnpmWorkspaceYaml(yaml), ["packages/*", "apps/*", "tools/cli"]);
});

test("ignores comments and blank lines in a pnpm-workspace.yaml packages block", () => {
  const yaml = `# root config\npackages:\n  - 'packages/*' # workspace packages\n\n  - 'apps/*'\n`;
  assert.deepEqual(parsePnpmWorkspaceYaml(yaml), ["packages/*", "apps/*"]);
});

test("stops collecting once the packages block ends", () => {
  const yaml = `packages:\n  - 'packages/*'\nonlyBuiltDependencies:\n  - some-pkg\n`;
  assert.deepEqual(parsePnpmWorkspaceYaml(yaml), ["packages/*"]);
});

test("returns an empty list when there's no packages key", () => {
  assert.deepEqual(parsePnpmWorkspaceYaml("onlyBuiltDependencies:\n  - some-pkg\n"), []);
});
