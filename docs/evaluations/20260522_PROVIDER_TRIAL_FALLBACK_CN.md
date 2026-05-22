# 2026-05-22 Provider Trial Fallback 复盘

## 目标

验证 `verified_provider_multi_agent` 的真实 provider 执行链不再因为 DS Pro 超时或非结构化输出停在人工介入，同时保持 fail-closed：

- 只有结构化 `status=pass`、合法外部 provider provenance、顶层和 package completion evidence 全部存在时，才允许写 workflow output。
- `fake/test/mock/simulation/local/deterministic` runner 即使返回结构化 pass，也不能获得 completion authority。
- 每次 provider attempt 必须成为 durable evidence，并写入 trial artifact、manifest run artifact 和 artifact ledger。

## 真实试验

命令：

```bash
npm run run:context-provider-trial -- \
  --input tmp/provider-trial/real-provider-trial-input.json \
  --output tmp/provider-trial/real-provider-trial-fallback-artifact.json \
  --workflow-output tmp/provider-trial/real-provider-trial-fallback-workflow-output.json \
  --max-package-count 1 \
  --timeout-seconds 90 \
  --model 'deepseek-v4-pro[1m]' \
  --fallback-model deepseek-v4-flash \
  --no-tools \
  --effort high \
  --max-budget-usd 1 \
  --created-at 2026-05-22T15:55:00.000+08:00
```

结果：

- `status=pass`
- `executor_kind=claude_deepseek_provider_executor`
- `command_runner_kind=spawn_sync`
- `external_calls=1`
- workflow output 写入成功
- 本轮 DS Pro 直接返回结构化 pass，因此没有触发 fallback

## 可控回归试验

为复现此前真实失败形态，使用受控 provider script：

- primary `deepseek-v4-pro[1m]` 返回退出码 0 和 `<bash>...</bash>` 非结构化 stdout。
- fallback `deepseek-v4-flash` 返回结构化 JSON pass，并使用正确 work package id。

结果：

- `status=pass`
- `external_calls=2`
- provider attempts：
  - `deepseek-v4-pro[1m]`: `status=fail`, `issue=provider_executor_unstructured_output`, `workflow_output_written=false`
  - `deepseek-v4-flash`: `status=pass`, `issue=null`, `workflow_output_written=true`
- manifest run artifact 和 artifact ledger 中的 `provider_attempts` 完全一致。
- selected work package `real-provider-trial-smoke` 更新为 `completed`。
- completion authority reason 为 `verified provider executor returned pass status, legal external-call provenance, and completion evidence`。

## DS 复审

使用 sharded Claude+DeepSeek 复审本轮改动。复审过程验证了 wrapper 的分片策略：

- 首个双文件 shard 超时后自动拆成单文件 shard。
- 单文件 shard 正常完成。
- Flash synthesis 返回 `PASS`。

DS 中间 findings 的处理：

- “fake runner guard 依赖字符串”被现有 adapter 层测试覆盖：`non_external_command_runner_provenance_not_allowed` 会阻断 fake/test runner completion。
- “provider_attempts 可能在缺少 run artifact 时静默丢弃”已有测试覆盖 ledger-only fallback；本轮 workflow output 也验证 manifest/ledger 镜像一致。

## 门禁

已通过：

- `node --test test/context-work-package-provider-executor.test.js`
- `npm run check:process-hardening`
- `npm test`
- `npm run check:closeout`
- `git diff --check`

## 结论

本轮不是对单次 DS 失败做临时补丁，而是把 provider executor 的 attempt 状态机扩展为：

1. primary provider timeout 或非结构化输出记录为失败 attempt。
2. 如果存在合法 fallback model，则继续下一次 provider attempt。
3. 只有最终结构化 pass 和 adapter completion authority 同时成立，workflow output 才能写入。
4. 所有 attempts 进入 durable evidence，供工作台和后续 continuation 读取。

下一步应进入 agent lifecycle pool cleanup： spawned child process 必须被跟踪、评估、关闭，并作为 durable workflow facts 暴露给 scheduler/workbench。
