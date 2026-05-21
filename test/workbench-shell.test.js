import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const FILES = [
  "apps/workbench/desktop.html",
  "apps/workbench/mobile.html",
  "apps/workbench/styles.css",
  "apps/workbench/workbench.js"
];

function read(path) {
  return readFileSync(path, "utf8");
}

test("workbench shell has separate desktop and mobile entries", () => {
  const desktop = read("apps/workbench/desktop.html");
  const mobile = read("apps/workbench/mobile.html");

  assert.match(desktop, /data-view="desktop"/);
  assert.match(mobile, /data-view="mobile"/);
  assert.notEqual(desktop, mobile);
  assert.match(desktop, /desktop-app/);
  assert.match(mobile, /phone-app/);
});

test("workbench shell consumes projection json instead of logs", () => {
  const script = read("apps/workbench/workbench.js");

  assert.match(script, /current-session-workbench-projection\.json/);
  assert.doesNotMatch(script, /console\.log|PROCESS\.md|PROJECT_STATUS\.json/);
});

test("desktop shell is fixed viewport without horizontal overflow by design", () => {
  const css = read("apps/workbench/styles.css");

  assert.match(css, /body\s*{[\s\S]*overflow:\s*hidden;/);
  assert.match(css, /\.desktop-app\s*{[\s\S]*width:\s*100vw;[\s\S]*height:\s*100dvh;/);
  assert.match(css, /\.workbench\s*{[\s\S]*min-width:\s*0;/);
});

test("workbench files avoid legacy and managed project references", () => {
  const combined = FILES.map(read).join("\n");

  assert.doesNotMatch(combined, /stock_dashboard|legacy\/|local-control-server|dashboard-ui/);
});
