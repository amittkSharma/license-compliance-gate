# Changelog

## 1.0.0 (2026-10-15)

### ⚠ BREAKING CHANGES

* Package renamed from `license-compliance-gate` to `@amittksharma/license-compliance-gate`. No code changes. The CLI command (`compliance-gate`) and `compliance.config.json` are unchanged; only install commands, `npx` calls and imports need the scoped name.

### Features

* Publish with npm provenance (`provenance=true` in `.npmrc`).
* Add `keywords` and `publishConfig.access: public` to `package.json`.
