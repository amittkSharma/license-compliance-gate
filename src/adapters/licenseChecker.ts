import type { Component, NoticesDocument } from "foss-notices-viewer";
import type { ModuleInfos } from "license-checker";

/**
 * `license-checker` keys its output `<name>@<version>`. Scoped packages
 * (`@scope/name@1.0.0`) contain a second `@`, so this splits on the *last*
 * one rather than the first.
 */
function splitPackageKey(key: string): { name: string; version?: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0) return { name: key };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function normalizeLicenseId(licenses: string | string[] | undefined): string {
  if (!licenses) return "UNKNOWN";
  return Array.isArray(licenses) ? licenses.join(" OR ") : licenses;
}

/**
 * Adapts `license-checker`'s output into foss-notices-viewer's normalized
 * `NoticesDocument` — the same model its SPDX/CycloneDX adapters produce,
 * so diffing, risk classification, and export all work unchanged.
 *
 * `directDependencyNames` marks a component "direct" by *name only* (not
 * name+version) — matching the scanned project's own `package.json`
 * dependencies/devDependencies keys. A name+version match would miss any
 * direct dependency declared with a caret/tilde range whose resolved
 * version differs from the declared one, which is effectively every
 * non-pinned dependency.
 */
export function parseLicenseCheckerOutput(
  output: ModuleInfos,
  directDependencyNames: ReadonlySet<string>,
): NoticesDocument {
  const components: Component[] = Object.entries(output).map(([key, entry]) => {
    const { name, version } = splitPackageKey(key);
    const licenseId = normalizeLicenseId(entry.licenses);
    return {
      name,
      version,
      homepage: entry.repository,
      author: entry.publisher,
      dependencyType: directDependencyNames.has(name) ? "direct" : "transitive",
      licenses: [{ id: licenseId, name: licenseId }],
      copyrights: [],
    };
  });

  return {
    source: "unknown",
    generatedAt: new Date().toISOString(),
    components,
  };
}
