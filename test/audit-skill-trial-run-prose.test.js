import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runWithProseResult(prose) {
  const dir = mkdtempSync(join(tmpdir(), "governance-audit-runner-prose-envelope-"));
  const fakeRunner = join(dir, "fake-runner.sh");
  const outputPath = join(dir, "out.json");
  const rawPath = join(dir, "raw.txt");
  const promptPath = join(dir, "prompt.md");
  writeFileSync(fakeRunner, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "node -e 'process.stdout.write(JSON.stringify({type:\"result\", subtype:\"success\", result:process.env.FAKE_PROSE_RESULT}))'"
  ].join("\n"));
  chmodSync(fakeRunner, 0o755);
  const result = spawnSync(process.execPath, [
    "tools/run-governance-audit-skill-trial.mjs",
    "--runner-command", fakeRunner,
    "--output", outputPath,
    "--raw-output", rawPath,
    "--prompt-output", promptPath
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_PROSE_RESULT: prose
    }
  });
  return { result, outputPath };
}

test("governance audit skill runner parses explicit prose final verdict from claude envelopes", () => {
  const { result, outputPath } = runWithProseResult("审计完成。\n\n**总评**: `通过` - 本次变更安全可发布。");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output.final_verdict, "通过");
  assert.equal(output.findings.length, 0);
});

test("governance audit skill runner keeps explicit prose failing verdicts blocking", () => {
  const { result, outputPath } = runWithProseResult("审计完成。\n\n最终结论：不通过");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /blocks closeout: 不通过/);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output.final_verdict, "不通过");
});

test("governance audit skill runner does not infer pass from non-verdict prose", () => {
  const { result } = runWithProseResult("审计完成。\n\n总评：请确保通过复核后再继续。");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not contain a parseable JSON object/);
});
