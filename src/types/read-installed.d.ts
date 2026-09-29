declare module "read-installed" {
  export interface InstalledPackageNode {
    name: string;
    version?: string;
    /** Every module physically found under this node's `node_modules` —
     * includes hoisted siblings this node never declared as a dependency.
     * Use `_dependencies`'s keys to know which entries are actually declared. */
    dependencies?: Record<string, InstalledPackageNode>;
    /** This node's own `package.json` `dependencies`, snapshotted before
     * resolution — the true declared edges (excludes `devDependencies`). */
    _dependencies?: Record<string, string>;
    /** This node's own `package.json` `devDependencies`, untouched. */
    devDependencies?: Record<string, string>;
  }

  function readInstalled(
    dir: string,
    opts: Record<string, unknown>,
    callback: (err: Error | null, data: InstalledPackageNode) => void,
  ): void;

  export = readInstalled;
}
