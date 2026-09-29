import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Component, NoticesDocument } from "foss-notices-viewer";

interface LockPackageEntry {
  name?: string;
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLockJson {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  packages?: Record<string, LockPackageEntry>;
}

/**
 * npm v7+ writes a `packages` map keyed by installed path
 * (`"node_modules/a/node_modules/@scope/b"`), each entry already carrying
 * its resolved `version` and (almost always) `license` — copied straight
 * from that package's own `package.json` at install time. That's enough to
 * build a full component list without ever touching `node_modules`, as
 * long as the lockfile itself was committed with `npm install`.
 * Only `lockfileVersion` 2/3 (npm v7+) write this `packages` map — an older
 * v1 lockfile, or a `yarn.lock`/`pnpm-lock.yaml`, isn't supported here and
 * throws instead of silently scanning nothing.
 * ponytail: npm-only. Add yarn.lock/pnpm-lock.yaml parsing if a project
 * needs lockfile-only scanning without an installed npm lockfile.
 */
export async function readPackageLock(dir: string): Promise<PackageLockJson> {
  const path = join(dir, "package-lock.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`No package-lock.json found at ${path} — lockfile-only scanning needs a committed npm lockfile.`);
  }
  const lock = JSON.parse(raw) as PackageLockJson;
  if (!lock.packages || (lock.lockfileVersion ?? 0) < 2) {
    throw new Error(
      `${path}: lockfile-only scanning needs an npm v7+ lockfile (lockfileVersion 2 or 3, with a "packages" map) — found lockfileVersion ${lock.lockfileVersion ?? "1"}.`,
    );
  }
  return lock;
}

function nameFromKey(key: string): string {
  const segments = key.split("node_modules/");
  return segments[segments.length - 1] ?? key;
}

function normalizeLicenseId(license: string | undefined): string {
  return license ?? "UNKNOWN";
}

/** Builds the component list straight from the lockfile's `packages` map — no `node_modules` read. */
function buildDocument(lock: PackageLockJson): NoticesDocument {
  const packages = lock.packages ?? {};
  const root = packages[""] ?? {};
  const directNames = new Set([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {})]);

  const components: Component[] = Object.entries(packages)
    .filter(([key]) => key !== "" && key.includes("node_modules/"))
    .map(([key, entry]) => {
      const name = nameFromKey(key);
      const licenseId = normalizeLicenseId(entry.license);
      return {
        name,
        version: entry.version,
        dependencyType: directNames.has(name) ? "direct" : "transitive",
        licenses: [{ id: licenseId, name: licenseId }],
        copyrights: [],
      } satisfies Component;
    });

  return {
    source: "unknown",
    generatedAt: new Date().toISOString(),
    project: { name: root.name ?? lock.name, version: root.version ?? lock.version },
    components,
  };
}

/**
 * Ancestor `node_modules` search order for resolving `name` from `key`,
 * nearest first — mirrors real Node module resolution walking up parent
 * directories: try nested under `key` itself, then each ancestor, finally
 * the root's own `node_modules`.
 */
function candidateKeysFor(key: string, name: string): string[] {
  const candidates: string[] = [];
  let prefix = key;
  for (;;) {
    candidates.push(prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`);
    if (!prefix) break;
    const cut = prefix.lastIndexOf("/node_modules/");
    prefix = cut === -1 ? "" : prefix.slice(0, cut);
  }
  return candidates;
}

/** Same shortest-chain BFS as `buildChainMap` in `scan.ts`, but walking the lockfile's own declared `dependencies` edges instead of an installed tree — see that function's doc comment for the general approach. */
function buildChainMapFromLockfile(lock: PackageLockJson): Map<string, string[]> {
  const packages = lock.packages ?? {};
  const root = packages[""] ?? {};
  const rootName = root.name ?? lock.name ?? "root";
  const chains = new Map<string, string[]>();
  const visited = new Set<string>([""]);
  const rootEdges = new Set([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {})]);
  let frontier: { key: string; chain: string[]; edges: Set<string> }[] = [{ key: "", chain: [rootName], edges: rootEdges }];

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { key, chain, edges } of frontier) {
      for (const name of edges) {
        const childKey = candidateKeysFor(key, name).find((candidate) => candidate in packages);
        if (!childKey || visited.has(childKey)) continue;
        visited.add(childKey);
        const child = packages[childKey]!;
        const childChain = [...chain, name];
        chains.set(`${name}@${child.version ?? ""}`, childChain);
        next.push({ key: childKey, chain: childChain, edges: new Set(Object.keys(child.dependencies ?? {})) });
      }
    }
    frontier = next;
  }

  return chains;
}

/** Scans `dir` using only its committed `package-lock.json` — no `node_modules` install required. See `readPackageLock`'s doc comment for the lockfile format this needs. */
export async function scanLockfile(dir: string): Promise<{ document: NoticesDocument; chains: Map<string, string[]> }> {
  const lock = await readPackageLock(dir);
  return { document: buildDocument(lock), chains: buildChainMapFromLockfile(lock) };
}
