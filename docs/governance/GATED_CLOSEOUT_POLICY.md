# Layered Governance Gate Policy

This policy keeps routine AI governance work from being blocked by unrelated full closeout
cost while preserving a hard path for risky changes.

## Levels

| Level | Scope | Required gates |
| --- | --- | --- |
| L0 | Documentation, examples, evidence, governance metadata | JSON parse when applicable, `git diff --check` |
| L1 | Test-only edits, test moves, test shard splits | syntax checks, affected tests, large-file gate, parity evidence for moved tests |
| L2 | Tool/helper refactors that preserve public behavior | syntax checks, affected tests, large-file gate |
| L3 | Workflow, server, scheduler, reviewer, or orchestration logic | affected tests, large-file gate, DeepSeek Pro or sharded review |
| L4 | User-visible runtime, Workbench app routes, package scripts/deps, browser gates, closeout entrypoints | full `npm test`, large-file gate, full `npm run check:closeout`, high-risk review |

## Escalation Rules

- Mixed changes use the highest applicable level.
- Low-confidence classification escalates at least to L2.
- `package.json`, `package-lock.json`, selector scripts, and closeout scripts are L4 because they can change the meaning of every gate.
- Workbench UI/runtime files under `apps/workbench/` are L4.
- `src/workflow/**` and `tools/workbench-server.mjs` are L3 unless they also change a public/browser closeout entrypoint.
- Full closeout is a batch-final or L4 gate, not the default for L0-L3 work.

## Commands

Plan gates without executing:

```bash
npm run governance:gates:plan
```

Execute the selected layer:

```bash
npm run governance:gates
```

Force the full release-style gate:

```bash
npm run governance:full-closeout
```

The selector is intentionally conservative. If it cannot classify safely, it chooses a higher
level rather than skipping meaningful verification.
