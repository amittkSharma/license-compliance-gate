import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLicenseCheckerOutput } from "../src/adapters/licenseChecker.js";

test("maps a direct dependency to a direct component", () => {
  const document = parseLicenseCheckerOutput(
    {
      "left-pad@1.3.0": {
        licenses: "MIT",
        repository: "https://github.com/left-pad/left-pad",
        publisher: "azer",
      },
    },
    new Set(["left-pad"]),
  );

  assert.equal(document.components.length, 1);
  const [component] = document.components;
  assert.ok(component);
  assert.equal(component.name, "left-pad");
  assert.equal(component.version, "1.3.0");
  assert.equal(component.dependencyType, "direct");
  assert.deepEqual(component.licenses, [{ id: "MIT", name: "MIT" }]);
});

test("marks a name absent from package.json as transitive", () => {
  const document = parseLicenseCheckerOutput(
    { "some-transitive-dep@2.0.0": { licenses: "Apache-2.0" } },
    new Set(["left-pad"]),
  );
  assert.equal(document.components[0]?.dependencyType, "transitive");
});

test("splits the package key on the last @, so scoped packages keep their scope", () => {
  const document = parseLicenseCheckerOutput(
    { "@babel/core@7.24.0": { licenses: "MIT" } },
    new Set(),
  );
  const [component] = document.components;
  assert.ok(component);
  assert.equal(component.name, "@babel/core");
  assert.equal(component.version, "7.24.0");
});

test("joins an array of licenses with OR", () => {
  const document = parseLicenseCheckerOutput(
    { "dual-licensed@2.0.0": { licenses: ["MIT", "Apache-2.0"] } },
    new Set(),
  );
  assert.equal(document.components[0]?.licenses[0]?.id, "MIT OR Apache-2.0");
});

test("falls back to UNKNOWN when license-checker found no license", () => {
  const document = parseLicenseCheckerOutput({ "mystery@0.0.1": {} }, new Set());
  assert.equal(document.components[0]?.licenses[0]?.id, "UNKNOWN");
});
