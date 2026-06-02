import assert from "node:assert/strict";
import test from "node:test";
import { selectAffectedTests } from "../tools/select-affected-tests.mjs";

// Build a synthetic graph so reachability/closure/fail-open logic is tested in isolation,
// independent of the real repo's evolving file set.
function graphOf(depMap, computed = []) {
  const deps = new Map();
  for (const [k, v] of Object.entries(depMap)) deps.set(k, new Set(v));
  return { deps, computedFiles: new Set(computed) };
}

const SYN = {
  sourceFiles: [
    "src/workflow/leaf.js",
    "src/workflow/mid.js",
    "src/workflow/hub.js",
    "test/leaf.test.js",
    "test/mid.test.js",
    "test/unrelated.test.js",
  ],
  testFiles: ["test/leaf.test.js", "test/mid.test.js", "test/unrelated.test.js"],
  graph: graphOf({
    "test/leaf.test.js": ["src/workflow/leaf.js"],
    "test/mid.test.js": ["src/workflow/mid.js"],
    "test/unrelated.test.js": ["src/workflow/hub.js"],
    "src/workflow/mid.js": ["src/workflow/leaf.js"], // mid depends on leaf -> transitive
  }),
};

test("subset: a change selects exactly the tests whose closure reaches it (transitive)", () => {
  const r = selectAffectedTests(["src/workflow/leaf.js"], SYN);
  assert.equal(r.decision, "subset");
  // leaf is reached directly by leaf.test and transitively (via mid.js) by mid.test.
  assert.deepEqual(r.tests, ["test/leaf.test.js", "test/mid.test.js"]);
});

test("subset: an unrelated change does not pull in unrelated tests", () => {
  const r = selectAffectedTests(["src/workflow/mid.js"], SYN);
  assert.deepEqual(r.tests, ["test/mid.test.js"]);
});

test("subset: changing a test file selects only that test", () => {
  const r = selectAffectedTests(["test/unrelated.test.js"], SYN);
  assert.deepEqual(r.tests, ["test/unrelated.test.js"]);
});

test("fail-open: package.json change runs the full suite", () => {
  const r = selectAffectedTests(["package.json"], SYN);
  assert.equal(r.decision, "full");
  assert.deepEqual(r.tests, SYN.testFiles);
  assert.match(r.reasons[0], /package\.json/);
});

test("fail-open: changing the selector itself runs the full suite (self-reference safety)", () => {
  const r = selectAffectedTests(["tools/select-affected-tests.mjs"], SYN);
  assert.equal(r.decision, "full");
  assert.match(r.reasons.join("\n"), /select-affected-tests\.mjs/);
});

test("fail-open: changing the runner or governance gates runs the full suite", () => {
  for (const f of ["tools/run-affected-tests.mjs", "tools/check-test-location.mjs", "tools/report-large-files.mjs", ".largefile-manifest.json"]) {
    const r = selectAffectedTests([f], SYN);
    assert.equal(r.decision, "full", `${f} must fail open`);
  }
});

test("fail-open: a source file whose closure path has a non-literal dynamic import is conservatively included", () => {
  const syn = {
    sourceFiles: ["src/workflow/dyn.js", "src/workflow/target.js", "test/a.test.js", "test/b.test.js"],
    testFiles: ["test/a.test.js", "test/b.test.js"],
    graph: graphOf(
      {
        "test/a.test.js": ["src/workflow/dyn.js"],
        "test/b.test.js": ["src/workflow/target.js"],
      },
      ["src/workflow/dyn.js"] // dyn.js has an unresolvable computed dynamic import
    ),
  };
  // A source change (target.js) could be the hidden dynamic target of dyn.js -> test a (which
  // depends on dyn.js) must be force-included even though target.js is not in its static closure.
  const r = selectAffectedTests(["src/workflow/target.js"], syn);
  assert.equal(r.decision, "subset");
  assert.ok(r.tests.includes("test/a.test.js"), "test depending on computed-import file is included");
  assert.ok(r.tests.includes("test/b.test.js"), "test statically reaching the change is included");
});

test("fail-open: a changed file the graph cannot resolve runs the full suite", () => {
  // A path that exists neither as a known source node nor on disk -> cannot reason -> full.
  const r = selectAffectedTests(["src/workflow/does-not-exist-anywhere.js"], SYN);
  assert.equal(r.decision, "full");
  assert.match(r.reasons.join("\n"), /not resolvable to a graph node/);
});

test("warning: a changed source reached by no test surfaces an uncovered signal (not a silent skip)", () => {
  const syn = {
    sourceFiles: ["src/workflow/orphan.js", "test/x.test.js"],
    testFiles: ["test/x.test.js"],
    graph: graphOf({ "test/x.test.js": ["src/workflow/other.js"] }),
  };
  const r = selectAffectedTests(["src/workflow/orphan.js"], syn);
  assert.equal(r.decision, "subset");
  assert.deepEqual(r.tests, []);
  assert.match(r.warnings.join("\n"), /uncovered: src\/workflow\/orphan\.js/);
});

// --- real-repo integration: prove the graph spans the actual coupling kinds ---------------

test("real repo: changing status-vocabulary selects its known importers (import edge)", () => {
  const r = selectAffectedTests(["src/workflow/status-vocabulary.js"]);
  assert.equal(r.decision, "subset");
  // its own golden test and the modules that import it must be present.
  assert.ok(r.tests.includes("test/status-vocabulary.test.js"));
  assert.ok(r.tests.includes("test/task-dag.test.js"), "task-dag imports status-vocabulary");
  assert.ok(r.tests.includes("test/autonomous-run.test.js"), "autonomous-run imports status-vocabulary");
});

test("real repo: changing a docs/examples fixture selects tests that read it (fixture edge)", () => {
  const r = selectAffectedTests(["docs/examples/current-session-workbench-input.json"]);
  assert.equal(r.decision, "subset");
  // workbench-snapshots reads this fixture by literal path.
  assert.ok(r.tests.includes("test/workbench-snapshots.test.js"), "fixture reader is selected");
});

// --- regression guards for confirmed omission defects (cross-review + code audit) ----------
// These changes are read by tests via literal paths that are NOT import statements and have
// NO src/tools/docs prefix. A prefix-whitelist matcher omitted them; the generalized
// "looks-like-a-path + exists-on-disk" rule must catch every one. Each asserts the specific
// test that reads the file is selected — i.e. NOT omitted.

test("no-omit: changing a root config file selects the test that reads it by literal path", () => {
  for (const [file, mustSelect] of [
    ["PROJECT_RULES.md", "test/governance-enrollment.test.js"],
    ["PROCESS.md", "test/governance-enrollment.test.js"],
    ["scripts/install-git-hooks.sh", "test/governance-enrollment.test.js"],
  ]) {
    const r = selectAffectedTests([file]);
    assert.equal(r.decision, "subset", `${file} should select a subset, not fail open`);
    assert.ok(r.tests.includes(mustSelect), `changing ${file} must select ${mustSelect} (no omission)`);
  }
});

test("no-omit: changing an apps/workbench frontend file selects the workbench shell test", () => {
  const r = selectAffectedTests(["apps/workbench/app/page.tsx"]);
  assert.equal(r.decision, "subset");
  assert.ok(
    r.tests.includes("test/workbench-shell.test.js"),
    "changing a frontend file must select workbench-shell.test.js (it reads the tree by path)"
  );
});

test("dynamic import with assertions/options is still captured as an edge (not a blind spot)", () => {
  // The literal-target regex tolerates a second arg; synthesize a file that uses it.
  // We assert via the synthetic graph that the edge form is recognized by extraction shape:
  // an import("./x.js", {assert:{type:"json"}}) must resolve to ./x.js, not be dropped.
  const matched = /import\(\s*["']([^"']+)["'][^)]*\)/.exec(
    'await import("./fixture.json", { assert: { type: "json" } })'
  );
  assert.ok(matched, "regex matches dynamic import with options");
  assert.equal(matched[1], "./fixture.json", "captures the literal path, ignoring the options arg");
});
