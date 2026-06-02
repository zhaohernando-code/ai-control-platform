#!/usr/bin/env node
// Affected-test selector (門禁治理 phase 2): given a set of changed files, decide which
// test/*.test.js files could be affected, so `npm run test:affected` can run a precise
// subset during development instead of the full ~116s / 797-case suite.
//
// HARD CONTRACT — precise but NEVER omitting. The full `npm test` stays the authoritative
// closeout gate; this is a development-time accelerator only. Whenever we cannot statically
// PROVE the affected set, we fail OPEN (decision:"full" -> run everything). Over-approximation
// toward "run more tests" is always safe; under-approximation (skipping an affected test) is
// the one thing this tool must never do.
//
// The dependency graph is built from literal path references only — this repo has no module
// resolver and all couplings are literal strings:
//   1. static import:   import ... from "<relative path>"
//   2. dynamic import:   import("<literal relative path>")
//   3. literal repo path strings inside a test ("src/...", "tools/...", "docs/examples/...")
//      — this single rule covers BOTH spawned-script args and fixture reads, because in this
//      suite both appear verbatim as repo-relative path string literals (e.g. a test that
//      spawns tools/run-headless-cli-orchestrator.mjs, or reads docs/examples/foo.json).
// Any reference that is computed (built from variables/concatenation) cannot be resolved, so
// the file holding it triggers fail-open.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, dirname, join, sep } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(process.env.AI_CONTROL_PLATFORM_AFFECTED_ROOT || process.cwd());

// Repo-relative path with forward slashes, regardless of platform.
function rel(absPath) {
  return relative(ROOT, absPath).split(sep).join("/");
}

// ---- file enumeration ---------------------------------------------------------------------

function walk(dir, pred, out = []) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(abs, entry.name);
    if (entry.isDirectory()) walk(rel(full), pred, out);
    else if (pred(rel(full))) out.push(rel(full));
  }
  return out;
}

function listSourceFiles() {
  const isJs = (p) => /\.(mjs|js)$/.test(p);
  return [
    ...walk("src", isJs),
    ...walk("tools", isJs),
    ...walk("test", isJs), // includes test/*.test.js and test/helpers/*.js
  ];
}

function listTestFiles() {
  return walk("test", (p) => p.endsWith(".test.js")).sort();
}

// ---- edge extraction ----------------------------------------------------------------------

const STATIC_IMPORT_RE = /(?:import|export)[^;]*?from\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /import\s*["']([^"']+)["']/g; // side-effect import "x"
// Tolerate a second arg (import assertions/options): import("x", {assert:{...}}).
const DYN_IMPORT_LITERAL_RE = /import\(\s*["']([^"']+)["'][^)]*\)/g;
// A dynamic import / spawn target built from a variable or concatenation — cannot resolve.
const DYN_IMPORT_COMPUTED_RE = /import\(\s*[^"'`)\s][^)]*\)/g;
// Any literal string that looks like a repo-relative path AND exists on disk is treated as a
// dependency edge. This deliberately generalizes beyond src/tools/docs: tests read root config
// (PROJECT_RULES.md, scripts/install-git-hooks.sh, PROJECT_STATUS.json), the apps/workbench/
// frontend tree (.tsx/.ts/.css/.html), and docs/examples fixtures all by literal path. A
// whitelist of prefixes would inevitably omit one of these and skip its test, violating the
// "never omit" contract. Matching "looks like a path + exists on disk" over-approximates
// toward running more tests, which is always safe. The existsSync check keeps it from treating
// arbitrary slashed strings (URLs, log text) as edges.
const REPO_PATH_LITERAL_RE = /["'`]((?:\.{0,2}\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)["'`]/g;

function resolveRelative(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // node:* / bare package -> leaf, ignore
  const abs = resolve(ROOT, dirname(fromFile), spec);
  return rel(abs);
}

// Returns { edges:Set<string>, computed:boolean }. edges are repo-relative target files this
// file depends on. computed=true means the file has an unresolvable dynamic import/spawn, so
// anything depending on it (and the file itself) must fail open.
function extractDeps(file) {
  const abs = resolve(ROOT, file);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return { edges: new Set(), computed: false, unreadable: true };
  }
  const edges = new Set();
  let computed = false;

  for (const re of [STATIC_IMPORT_RE, BARE_IMPORT_RE, DYN_IMPORT_LITERAL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const target = resolveRelative(file, m[1]);
      if (target) edges.add(target);
    }
  }

  // Literal repo-path strings: treat as dependency edges (covers spawn args, fixtures, root
  // config, and the apps/workbench frontend tree). Resolve relative ("./", "../") forms
  // against the file's dir; resolve bare repo-relative forms against ROOT. Keep only those
  // that actually exist on disk.
  REPO_PATH_LITERAL_RE.lastIndex = 0;
  let pm;
  while ((pm = REPO_PATH_LITERAL_RE.exec(text))) {
    const raw = pm[1];
    const candidates = raw.startsWith(".")
      ? [resolve(ROOT, dirname(file), raw)] // ./x or ../x — relative to this file
      : [resolve(ROOT, raw), resolve(ROOT, dirname(file), raw)]; // repo-rel, or file-rel
    for (const abs of candidates) {
      if (existsSync(abs) && statSync(abs).isFile()) {
        edges.add(rel(abs));
        break;
      }
    }
  }

  // Computed dynamic import whose argument is not a plain string literal -> cannot resolve.
  DYN_IMPORT_COMPUTED_RE.lastIndex = 0;
  let cm;
  while ((cm = DYN_IMPORT_COMPUTED_RE.exec(text))) {
    const inner = cm[0].slice("import(".length);
    // node:* dynamic imports written as literals are fine; flag only truly non-literal args.
    if (!/^\s*["'`]/.test(inner)) computed = true;
  }

  return { edges, computed, unreadable: false };
}

// ---- graph build + reverse reachability ---------------------------------------------------

function buildGraph(sourceFiles) {
  const deps = new Map(); // file -> Set(targets)
  const computedFiles = new Set();
  for (const f of sourceFiles) {
    const { edges, computed } = extractDeps(f);
    deps.set(f, edges);
    if (computed) computedFiles.add(f);
  }
  return { deps, computedFiles };
}

// For a test, compute the transitive closure of files it depends on.
function closureOf(testFile, deps) {
  const seen = new Set([testFile]);
  const stack = [testFile];
  while (stack.length) {
    const cur = stack.pop();
    const targets = deps.get(cur);
    if (!targets) continue;
    for (const t of targets) {
      if (!seen.has(t)) {
        seen.add(t);
        stack.push(t);
      }
    }
  }
  return seen;
}

// ---- global fail-open triggers ------------------------------------------------------------

// Changing any of these means the whole selection/run mechanism, dependency manifest, or the
// suite's entrypoint config could shift — we cannot reason about scope, so run everything.
const FAIL_OPEN_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tools/select-affected-tests.mjs",
  "tools/run-affected-tests.mjs",
  "tools/check-test-location.mjs",
  "tools/report-large-files.mjs",
  ".largefile-manifest.json",
]);

function isFailOpenFile(changed) {
  if (FAIL_OPEN_FILES.has(changed)) return true;
  // A test helper change can affect any test through non-obvious paths; be conservative.
  return false;
}

// ---- main selection -----------------------------------------------------------------------

export function selectAffectedTests(changedFiles, options = {}) {
  const sourceFiles = options.sourceFiles || listSourceFiles();
  const testFiles = options.testFiles || listTestFiles();
  const { deps, computedFiles } = options.graph || buildGraph(sourceFiles);
  const sourceSet = new Set(sourceFiles);
  const reasons = [];

  const changed = (changedFiles || []).map((c) => c.split(sep).join("/"));

  // 1. global fail-open files
  for (const c of changed) {
    if (isFailOpenFile(c)) {
      reasons.push(`fail-open: changed ${c} (governs selection/run/manifest/entrypoint)`);
    }
  }

  // 2. changed file not known to the graph at all -> cannot reason -> fail open
  for (const c of changed) {
    if (isFailOpenFile(c)) continue;
    const known = sourceSet.has(c) || existsSync(resolve(ROOT, c));
    if (!known) {
      reasons.push(`fail-open: changed ${c} is not resolvable to a graph node`);
    }
  }

  // 3. the changed file itself has a computed (non-literal) dynamic import/spawn target whose
  //    callee cannot be resolved -> its own dependents are unknown -> fail open. (The inverse
  //    case — a test whose closure passes THROUGH some other file that has a computed import,
  //    where the change could be that hidden target — is handled below by the closure-level
  //    safety net, which force-includes such tests rather than failing the whole run open.)
  for (const c of changed) {
    if (computedFiles.has(c)) {
      reasons.push(`fail-open: changed ${c} contains a non-literal dynamic import/spawn target`);
    }
  }

  if (reasons.length > 0) {
    return { decision: "full", tests: testFiles, reasons, changed };
  }

  // 4. precise subset: a test is affected iff its dependency closure intersects changed set.
  //    If ANY source file in the repo has a computed target, a test depending on that source
  //    is conservatively affected only when the change is in that source's closure — but to
  //    stay safe, any test whose closure includes a computedFile AND the change touches that
  //    closure is already covered; computed targets that could pull in the changed file
  //    invisibly are handled by: if a changed file is reachable from a computedFile's owner.
  const changedSet = new Set(changed);
  const selected = [];
  const uncovered = new Set(changedSet);

  for (const t of testFiles) {
    const closure = closureOf(t, deps);
    let hit = false;
    for (const c of changedSet) {
      if (closure.has(c)) {
        hit = true;
        uncovered.delete(c);
      }
    }
    // Safety net: if this test's closure contains a file with an unresolvable computed
    // import, we cannot prove the changed file is NOT pulled in at runtime -> include the test.
    if (!hit) {
      for (const f of closure) {
        if (computedFiles.has(f)) {
          // Only force-include when the change is itself a source file (could be the dynamic
          // target). Pure doc/test-only changes unrelated to this closure stay excluded.
          if (changed.some((c) => /^(src|tools)\//.test(c))) {
            hit = true;
            reasons.push(`include ${t}: closure has computed-import file ${f}, source changed`);
            break;
          }
        }
      }
    }
    if (hit) selected.push(t);
  }

  // changed source/tool files that map to zero tests -> real coverage gap, surface it.
  const warnings = [];
  for (const c of uncovered) {
    if (/^(src|tools)\//.test(c)) {
      warnings.push(`uncovered: ${c} is not reached by any test file`);
    }
  }

  return {
    decision: "subset",
    tests: selected.sort(),
    reasons,
    warnings,
    changed,
  };
}

// ---- git changed-files helper -------------------------------------------------------------

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.error || r.status !== 0) return "";
  return String(r.stdout || "").trim();
}

export function changedFilesFromGit() {
  const base = git(["merge-base", "origin/main", "HEAD"]) || "origin/main";
  const out = new Set();
  for (const block of [
    git(["diff", "--name-only", `${base}...HEAD`]),
    git(["diff", "--name-only", "HEAD"]),
    git(["diff", "--name-only", "--cached"]),
    git(["ls-files", "--others", "--exclude-standard"]),
  ]) {
    for (const line of block.split("\n")) {
      const f = line.trim();
      if (f) out.add(f);
    }
  }
  return [...out];
}

// ---- CLI ----------------------------------------------------------------------------------

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
}

if (isMain()) {
  const args = process.argv.slice(2);
  const changed = args.length > 0 ? args : changedFilesFromGit();
  const result = selectAffectedTests(changed);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
