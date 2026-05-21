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
  assert.match(desktop, /data-history-select/);
  assert.match(mobile, /data-history-select/);
  assert.match(desktop, /data-bind="closeout_status"/);
  assert.match(mobile, /data-bind="closeout_status"/);
  assert.match(desktop, /data-bind="resume_health_status"/);
  assert.match(mobile, /data-bind="resume_health_status"/);
  assert.match(desktop, /data-bind="provider_health_value"/);
  assert.match(mobile, /data-bind="provider_health_value"/);
  assert.match(desktop, /data-bind="scheduler_dispatch_status"/);
  assert.match(mobile, /data-bind="scheduler_dispatch_status"/);
  assert.match(desktop, /data-bind="counter_scheduler_dispatch_steps"/);
  assert.match(mobile, /data-bind="counter_scheduler_dispatch_steps"/);
  assert.match(desktop, /data-provider-health="pass"/);
  assert.match(mobile, /data-provider-health="timeout"/);
  assert.notEqual(desktop, mobile);
  assert.match(desktop, /desktop-app/);
  assert.match(mobile, /phone-app/);
});

test("workbench shell consumes projection json instead of logs", () => {
  const script = read("apps/workbench/workbench.js");
  const source = read("apps/workbench/projection-source.js");

  assert.match(script, /createProjectionSource/);
  assert.match(script, /closeout_status/);
  assert.match(script, /resume_health_status/);
  assert.match(script, /provider_health_value/);
  assert.match(script, /scheduler_dispatch_status/);
  assert.match(script, /counter_scheduler_dispatch_steps/);
  assert.match(script, /recordProviderHealth/);
  assert.match(script, /Smoke 写入失败/);
  assert.match(source, /current-session-workbench-projection\.json/);
  assert.doesNotMatch(script, /console\.log|PROCESS\.md|PROJECT_STATUS\.json/);
});

test("desktop shell is fixed viewport without horizontal overflow by design", () => {
  const css = read("apps/workbench/styles.css");

  assert.match(css, /body\s*{[\s\S]*overflow:\s*hidden;/);
  assert.match(css, /\.desktop-app\s*{[\s\S]*width:\s*100vw;[\s\S]*height:\s*100dvh;/);
  assert.match(css, /\.workbench\s*{[\s\S]*min-width:\s*0;/);
});

test("workbench files avoid legacy and managed project references", () => {
  const combined = [...FILES, "apps/workbench/projection-source.js"].map(read).join("\n");

  assert.doesNotMatch(combined, /stock_dashboard|legacy\/|local-control-server|dashboard-ui/);
});

test("workbench controls do not show success when operator event persistence fails", () => {
  const script = read("apps/workbench/workbench.js");

  assert.match(script, /事件写入失败/);
  assert.match(script, /事件未写入/);
  assert.match(script, /button\.dataset\.eventState = "recorded"/);
  assert.match(script, /catch \{[\s\S]*button\.dataset\.eventState = "failed";[\s\S]*return;[\s\S]*\}/);
});
