import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import licenseChecker from "license-checker";
import type { ModuleInfos } from "license-checker";
import readInstalled from "read-installed";
import type { InstalledPackageNode } from "read-installed";
import type { NoticesDocument } from "foss-notices-viewer";
import { parseLicenseCheckerOutput } from "./adapters/licenseChecker.js";
import { scanLockfile } from "./lockfile.js";
import type { ScanSource } from "./types.js";

function runLicenseChecker(dir: string): Promise<ModuleInfos> {
  return new Promise((resolvePromise, reject) => {
    licenseChecker.init({ start: dir, json: true }, (error, packages) => {
      if (error) reject(error);
      else resolvePromise(packages);
    });
  });
}

function readInstalledTree(dir: string): Promise<InstalledPackageNode> {
  return new Promise((resolvePromise, reject) => {
    readInstalled(dir, {}, (error, data) => {
      if (error) reject(error);
      else resolvePromise(data);
    });
  });
}

interface ProjectPackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

async function readProjectPackageJson(dir: string): Promise<ProjectPackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function getPackageJsonWorkspacePatterns(pkg: ProjectPackageJson | undefined): string[] {
  if (!pkg?.workspaces) return [];
  return Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? []);
}

/**
 * Parses the `packages:` block-list out of a `pnpm-workspace.yaml` file —
 * pnpm's own docs only ever show this simple form (a top-level `packages:`
 * key followed by `- 'glob'` lines), so that's all this reads. Not a real
 * YAML parser: flow-style lists (`packages: [a, b]`) and anything nested
 * under a list item are not supported.
 * ponytail: hand-rolled block-list reader instead of a `yaml` dependency —
 * swap in the `yaml` package if a project's file needs more than this.
 */
export function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/#.*$/, "");
    if (!inPackages) {
      if (/^packages:\s*$/.test(line.trim())) inPackages = true;
      continue;
    }
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item?.[1]) {
      patterns.push(item[1].replace(/^['"]|['"]$/g, ""));
    } else if (line.trim() !== "") {
      break;
    }
  }
  return patterns;
}

async function readPnpmWorkspaceYaml(rootDir: string): Promise<string | undefined> {
  return readFile(join(rootDir, "pnpm-workspace.yaml"), "utf8").catch(() => undefined);
}

function getWorkspacePatterns(pnpmWorkspaceYaml: string | undefined, pkg: ProjectPackageJson | undefined): string[] {
  if (pnpmWorkspaceYaml !== undefined) return parsePnpmWorkspaceYaml(pnpmWorkspaceYaml);
  return getPackageJsonWorkspacePatterns(pkg);
}

/**
 * Resolves npm/yarn `workspaces` patterns to actual package directories.
 * Supports an exact path (`"tools/cli"`) and a single trailing `/*` wildcard
 * (`"packages/*"`) — together these cover the vast majority of real-world
 * workspace configs without needing a glob library. A pattern using anything
 * else (`**`, brace expansion, `!negation`) is not supported and is skipped
 * with a warning rather than silently mismatched.
 * ponytail: no real glob engine, single-level `/*` only — add `fast-glob` if
 * a project actually uses nested or negated workspace patterns.
 */
export async function resolveWorkspaceDirs(rootDir: string, patterns: string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes("*") && !pattern.endsWith("/*")) {
      console.warn(`Unsupported workspaces pattern "${pattern}" — only an exact path or a trailing "/*" is supported, skipping.`);
      continue;
    }
    if (pattern.endsWith("/*")) {
      const parent = join(rootDir, pattern.slice(0, -2));
      const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.push(join(parent, entry.name));
      }
    } else {
      dirs.push(join(rootDir, pattern));
    }
  }
  return dirs;
}

/**
 * Unions the root project's own direct dependencies with those declared by
 * each workspace package — a monorepo dependency declared only in a
 * workspace package's `package.json` (not the root's) is still a direct
 * dependency of the monorepo, even though the root's own `package.json`
 * never mentions it.
 */
export function collectDirectDependencyNames(
  projectPackageJson: ProjectPackageJson | undefined,
  workspacePackageJsons: (ProjectPackageJson | undefined)[],
): Set<string> {
  const names = new Set<string>();
  for (const pkg of [projectPackageJson, ...workspacePackageJsons]) {
    for (const name of Object.keys(pkg?.dependencies ?? {})) names.add(name);
    for (const name of Object.keys(pkg?.devDependencies ?? {})) names.add(name);
  }
  return names;
}

interface ScanTargets {
  projectPackageJson: ProjectPackageJson | undefined;
  workspaceDirs: string[];
  workspacePackageJsons: (ProjectPackageJson | undefined)[];
  directDependencyNames: Set<string>;
  /** Directories to run `license-checker`/`read-installed` against — just the
   * root, unless this is a pnpm workspace (see `scanDirectory`'s doc comment). */
  scanTargets: string[];
  isPnpmWorkspace: boolean;
}

/** Shared by `scanDirectory` (license data) and `computeDependencyChains` (the
 * raw installed tree) so both agree on which directories make up "this project". */
async function resolveScanTargets(absoluteDir: string): Promise<ScanTargets> {
  const [projectPackageJson, pnpmWorkspaceYaml] = await Promise.all([
    readProjectPackageJson(absoluteDir),
    readPnpmWorkspaceYaml(absoluteDir),
  ]);

  const workspacePatterns = getWorkspacePatterns(pnpmWorkspaceYaml, projectPackageJson);
  const workspaceDirs = await resolveWorkspaceDirs(absoluteDir, workspacePatterns);
  const workspacePackageJsons = await Promise.all(workspaceDirs.map(readProjectPackageJson));
  const directDependencyNames = collectDirectDependencyNames(projectPackageJson, workspacePackageJsons);

  const isPnpmWorkspace = pnpmWorkspaceYaml !== undefined && workspaceDirs.length > 0;
  const scanTargets = isPnpmWorkspace ? [absoluteDir, ...workspaceDirs] : [absoluteDir];

  return { projectPackageJson, workspaceDirs, workspacePackageJsons, directDependencyNames, scanTargets, isPnpmWorkspace };
}

/**
 * Scanning a pnpm workspace package's own directory makes `license-checker`
 * include that package's own name/version as one of its "dependencies" (it
 * always includes the scanned directory's own package.json). That's harmless
 * noise specific to per-package scanning, so it's stripped back out here —
 * the root's own self-entry is left alone, matching every other scan.
 */
function omitSelfEntry(pkgs: ModuleInfos, selfPkg: ProjectPackageJson | undefined): ModuleInfos {
  if (!selfPkg?.name || !selfPkg.version) return pkgs;
  const key = `${selfPkg.name}@${selfPkg.version}`;
  if (!(key in pkgs)) return pkgs;
  const { [key]: _self, ...rest } = pkgs;
  return rest;
}

/**
 * Scans `dir` with `license-checker` and returns a normalized
 * `NoticesDocument`. Direct-dependency classification is name-only, read
 * straight from the scanned project's own `package.json` (plus, for a
 * workspaces root, every workspace package's `package.json` too) — see
 * `parseLicenseCheckerOutput`'s doc comment for why name-only. Workspace
 * membership comes from `pnpm-workspace.yaml` when present, otherwise from
 * `package.json`'s `workspaces` field (npm/yarn) — pnpm ignores the latter,
 * so a `pnpm-workspace.yaml` file always wins when both exist.
 *
 * npm/yarn workspaces hoist every dependency into the root `node_modules`,
 * so one `license-checker` run at the root sees everything. pnpm never
 * hoists — it links each package's dependencies out of a `.pnpm` content
 * store instead — so a root-only scan of a pnpm workspace finds nothing but
 * the root package itself. For a `pnpm-workspace.yaml` root, this instead
 * runs `license-checker` once per workspace package (where pnpm's symlinks
 * do resolve) plus once at the root, and merges the results, deduplicating
 * on `license-checker`'s own `name@version` key.
 */
export async function scanDirectory(dir: string): Promise<NoticesDocument> {
  const absoluteDir = resolve(dir);
  const { projectPackageJson, workspaceDirs, workspacePackageJsons, directDependencyNames, isPnpmWorkspace } =
    await resolveScanTargets(absoluteDir);

  const rootPackages = await runLicenseChecker(absoluteDir);
  const workspacePackagesLists = isPnpmWorkspace
    ? await Promise.all(
        workspaceDirs.map(async (target, i) => {
          const pkgs = await runLicenseChecker(target).catch(() => ({}) as ModuleInfos);
          return omitSelfEntry(pkgs, workspacePackageJsons[i]);
        }),
      )
    : [];
  const packages: ModuleInfos = Object.assign({}, rootPackages, ...workspacePackagesLists);

  const document = parseLicenseCheckerOutput(packages, directDependencyNames);
  document.project = {
    name: projectPackageJson?.name,
    version: projectPackageJson?.version,
  };
  return document;
}

/**
 * BFS over the real installed dependency tree (from `read-installed`,
 * `license-checker`'s own underlying tree walker — see its source), recording
 * the shortest chain of package names from the project root down to each
 * package it transitively depends on. A package can be required by many
 * parents in a real tree; this keeps one honest example chain per
 * `name@version`, not an exhaustive list of every route.
 *
 * Walks `_dependencies` (each node's own declared `dependencies`, snapshotted
 * before resolution), not `dependencies` (every module `read-installed` found
 * physically present in that node's `node_modules`, including hoisted
 * siblings it never asked for) — with a flat/hoisted install, almost every
 * package physically sits directly under the root's `node_modules`, so
 * walking `dependencies` would report a false "root -> package" chain for
 * things that are really nested several levels deep. The root's own
 * `devDependencies` are included too, since those are genuinely direct.
 *
 * A monorepo root's own `package.json` frequently declares few or no
 * "dependencies" itself — the real application dependencies live inside each
 * workspace package's own `package.json` instead. Those workspace packages
 * are still physically linked into the root's `node_modules` (so they exist
 * as resolvable nodes in `tree.dependencies`), just not as a declared edge
 * from the root — so `workspacePackageNames` seeds one extra BFS root per
 * workspace package, using its own `_dependencies` from there. Without this,
 * anything only ever declared by a workspace package (not the root, not any
 * devDependency) would never get a chain at all.
 *
 * A node's own `dependencies` is only populated when that node has its own
 * `node_modules` folder — with a flat/hoisted npm install (the common case
 * for a large monorepo with no version conflicts), most non-root packages,
 * including workspace packages, have no `node_modules` of their own at all,
 * so their declared deps physically live in the tree root's `node_modules`
 * instead. Real Node module resolution walks up parent directories to find
 * them; falling back to the tree root's `dependencies` when a node doesn't
 * have its own copy mimics that for the common single-level-hoist case.
 * ponytail: falls back to the tree root only, not the full ancestor chain —
 * add real per-node ancestor walking if a repo needs nested-hoist resolution.
 */
function buildChainMap(tree: InstalledPackageNode, workspacePackageNames: string[] = []): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const visited = new Set<InstalledPackageNode>([tree]);
  const rootEdges = new Set([...Object.keys(tree._dependencies ?? {}), ...Object.keys(tree.devDependencies ?? {})]);
  let frontier: { node: InstalledPackageNode; chain: string[]; edges: Set<string> }[] = [
    { node: tree, chain: [tree.name], edges: rootEdges },
  ];

  for (const name of workspacePackageNames) {
    const node = tree.dependencies?.[name];
    if (!node || visited.has(node)) continue;
    visited.add(node);
    const chain = [tree.name, node.name];
    chains.set(`${node.name}@${node.version ?? ""}`, chain);
    // A workspace package is itself a project, same as the tree root — its own
    // devDependencies are genuinely direct too, not just its "dependencies".
    const edges = new Set([...Object.keys(node._dependencies ?? {}), ...Object.keys(node.devDependencies ?? {})]);
    frontier.push({ node, chain, edges });
  }

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { node, chain, edges } of frontier) {
      for (const name of edges) {
        const child = node.dependencies?.[name] ?? tree.dependencies?.[name];
        if (!child || visited.has(child)) continue;
        visited.add(child);
        const childChain = [...chain, child.name];
        chains.set(`${child.name}@${child.version ?? ""}`, childChain);
        next.push({ node: child, chain: childChain, edges: new Set(Object.keys(child._dependencies ?? {})) });
      }
    }
    frontier = next;
  }

  return chains;
}

/**
 * Maps `name@version` -> the shortest dependency chain (root name first,
 * offending package last) for every package reachable from `dir`. Used to
 * show *why* a non-permissive license is in the tree at all. Runs the same
 * scan targets as `scanDirectory` (root, plus each workspace package for a
 * pnpm workspace), merging on the shortest chain found across targets. For
 * an npm/yarn workspaces root (the first scan target), also seeds each
 * workspace package by name — see `buildChainMap`'s doc comment for why.
 */
export async function computeDependencyChains(dir: string): Promise<Map<string, string[]>> {
  const { scanTargets, workspacePackageJsons } = await resolveScanTargets(resolve(dir));
  const workspacePackageNames = workspacePackageJsons
    .map((pkg) => pkg?.name)
    .filter((name): name is string => name !== undefined);
  const chains = new Map<string, string[]>();

  for (const [index, target] of scanTargets.entries()) {
    const tree = await readInstalledTree(target).catch(() => undefined);
    if (!tree) continue;
    const seeds = index === 0 ? workspacePackageNames : [];
    for (const [key, chain] of buildChainMap(tree, seeds)) {
      const existing = chains.get(key);
      if (!existing || chain.length < existing.length) chains.set(key, chain);
    }
  }

  return chains;
}

/**
 * Scans `dir` from the given `source` — `"node_modules"` (default) runs
 * `scanDirectory`/`computeDependencyChains` against a real install;
 * `"lockfile"` reads only the committed `package-lock.json`, no install
 * required (see `scanLockfile`'s doc comment for its npm-only, no-workspace
 * limitations). Both callers of a scan (`scan`, `scan-workspace`) go through
 * this so the two commands can never disagree about what a given `source`
 * means.
 */
export async function scanWithSource(
  dir: string,
  source: ScanSource = "node_modules",
): Promise<{ document: NoticesDocument; chains: Map<string, string[]> }> {
  if (source === "lockfile") return scanLockfile(dir);
  const [document, chains] = await Promise.all([scanDirectory(dir), computeDependencyChains(dir)]);
  return { document, chains };
}
