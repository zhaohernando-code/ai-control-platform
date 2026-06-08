import { spawnSync } from "node:child_process";

export function truncate(value, maxLength = 12000) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

export function runEvidenceCommand(label, command, options) {
  const result = spawnSync("bash", ["-lc", command], {
    cwd: options.projectRoot,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      PATH: [
        process.env.PATH,
        "/Users/hernando_zhao/.local/bin",
        "/Users/hernando_zhao/.nvm/versions/node/v22.16.0/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin"
      ].filter(Boolean).join(":")
    }
  });
  return [
    `$ ${command}`,
    `exit_code=${result.status ?? (result.error ? 1 : 0)}`,
    result.stdout ? truncate(result.stdout, 8000) : "",
    result.stderr ? `[stderr]\n${truncate(result.stderr, 4000)}` : "",
    result.error ? `[error]\n${result.error.message}` : ""
  ].filter(Boolean).join("\n");
}

export function collectPreflightEvidence(options) {
  const quotedRoute = JSON.stringify(options.route);
  const commands = [
    ["served route headers", `curl -sS -L -I --max-time 10 ${quotedRoute}`],
    ["served route html", `curl -sS -L --max-time 10 ${quotedRoute} | sed -n '1,22p'`],
    ["served next static asset", "asset=$(curl -sS -L --max-time 10 http://127.0.0.1:4180/projects/ai-control-platform/ | grep -o '/projects/ai-control-platform/_next/static/chunks/main-app-[^\"]*\\.js' | head -1); test -n \"$asset\" && curl -sS -I --max-time 10 \"http://127.0.0.1:4180$asset\" | sed -n '1,8p'"],
    ["served favicon asset", "curl -sS -I --max-time 10 http://127.0.0.1:4180/projects/ai-control-platform/favicon.svg | sed -n '1,8p'"],
    ["claimed antd code", "rg -n \"from ['\\\"]antd['\\\"]|@ant-design/nextjs-registry|antd\\\"\" apps/workbench/app/page.tsx apps/workbench/app/providers.tsx apps/workbench/app/shell.tsx apps/workbench/package.json -S | sed -n '1,12p'"],
    ["server route mapping", "rg -n \"nextjsMountHtml|nextjsAppIndexPath|isProjectMountRoot|_next/static|favicon.svg\" tools/workbench-server.mjs | sed -n '1,20p'"],
    ["task failure recovery source", "rg -n \"retryRequirementPlan|closeRequirementTask|retry-plan|requirements/close|isRecoverableFailedTask|关闭失败任务|重试计划|closed_failed|retry_requirement_plan_generation\" src tools apps/workbench test | sed -n '1,80p'"],
    ["task failure recovery tests", "node --test test/requirement-intake.test.js test/workbench-projection.test.js test/workbench-server.test.js"],
    ["live task failure projection", "curl -sS --max-time 10 http://127.0.0.1:4182/api/workbench/projection | node -e 'let s=\"\"; process.stdin.on(\"data\", d => s += d); process.stdin.on(\"end\", () => { const p = JSON.parse(s); const task = (p.project_management && p.project_management.task_items || []).find((item) => item.task_id === \"requirement-tab-20260528064224\"); console.log(JSON.stringify({ task_id: task && task.task_id, title: task && task.title, status: task && task.status, phase: task && task.phase, next_action: task && task.next_action_readout && task.next_action_readout.action, failure_reason: task && task.failure_reason }, null, 2)); })'"],
    ["targeted quality gates", "node --test test/audit-skill-trial-run.test.js test/requirement-intake.test.js test/workbench-projection.test.js test/workbench-server.test.js test/live-route-probe.test.js"],
    ["closeout gate wiring", "rg -n \"check:closeout|governance audit skill trial|workbench live route acceptance|isolated worktree closeout|mainline release readiness\" package.json tools/check-closeout.mjs src test | sed -n '1,60p'"],
    ["git release state", "branch=$(git branch --show-current); git status --short; if [ \"$branch\" = \"main\" ] || [ \"${AI_CONTROL_CLOSEOUT_REQUIRE_MAINLINE:-0}\" = \"1\" ]; then git rev-list --left-right --count origin/main...HEAD; else echo \"isolated_worktree_closeout=true\"; echo \"mainline_release_readiness=deferred_to_parent_release_step\"; fi; git log --oneline -5"],
    ["security boundary evidence", "rg -n \"allowedHistoryRoots|safeStaticPath|unsafe|unauthorized|auth|token|host\" tools/workbench-server.mjs src tools test | sed -n '1,40p'"],
    ["recovery and publish evidence", "rg -n \"rollback|recovery|resume|publish|snapshot|launchctl|kickstart|live route\" scripts tools src test docs | sed -n '1,40p'"],
    ["cost and budget controls", "rg -n \"budget|max-budget|timeout|cost|bounded|risk|profile\" tools src test package.json | sed -n '1,40p'"],
    ["auto repair workflow evidence", "rg -n \"governance audit failure schedules|Repair governance audit|repair_schedule|context work package|next-action\" src test tools | sed -n '1,40p'"],
    ["knowledge retention evidence", "rg -n \"handoff|PROJECT_STATUS|DECISIONS|PROCESS|artifact ledger|workflow state|durable\" PROJECT_STATUS.json PROCESS.md DECISIONS.md docs src test tools | sed -n '1,40p'"],
    ["model collaboration evidence", "rg -n \"agent_invocation|deepseek|reviewer|model routing|provider\" tools src test docs package.json | sed -n '1,40p'"]
  ];
  const evidenceItems = [];
  const text = commands.map(([label, command]) => {
    const output = runEvidenceCommand(label, command, options);
    const id = label.replaceAll(" ", "-");
    evidenceItems.push({
      id,
      kind: "command",
      source: label,
      collected_at: new Date().toISOString(),
      collector: "run-governance-audit-skill-trial",
      command_or_path: command,
      exit_code: Number(/exit_code=(\d+)/u.exec(output)?.[1] || 1),
      result_summary: truncate(output, 1000)
    });
    return [`## ${id}: ${label}`, output].join("\n");
  }).join("\n\n");
  return { text, evidenceItems };
}
