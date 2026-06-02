"use client";

import { useEffect, useMemo, useState } from "react";

import { Button, Card, Col, Descriptions, Row, Space, Statistic, Tag, Typography } from "antd";
import {
  ApiOutlined,
  CheckCircleOutlined,
  PlayCircleOutlined,
  SyncOutlined
} from "@ant-design/icons";

import {
  nextProjectionIdFromMutation,
  projectionFromMutation,
  recordOperatorEvent,
  recordProviderHealth,
  runAutonomousSchedulerLoop,
  runNextAction,
  runSchedulerDispatch,
  resumeAutonomousSchedulerLoop
} from "@/lib/api/operations";
import type { ProjectionResponse } from "@/lib/api/projection";

const { Text } = Typography;

type ProjectionRecord = ProjectionResponse & Record<string, unknown>;

interface OperationPanelProps {
  projection: ProjectionResponse | null;
  onProjectionChange: (projection: ProjectionResponse) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = "--"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function translatedStatus(value: unknown): string {
  const normalized = String(value || "").trim();
  if (normalized === "pass") return "通过";
  if (normalized === "ready") return "就绪";
  if (normalized === "blocked") return "受阻";
  if (normalized === "fail") return "失败";
  if (normalized === "not_configured") return "未配置";
  return normalized || "--";
}

function translatedBool(value: unknown): string {
  return value === true ? "是" : "否";
}

function translatedStrategy(value: unknown): string {
  return value === "projected_next_action" ? "按推荐动作推进" : text(value);
}

function translatedExecutionMode(value: unknown): string {
  return value === "dry_run" ? "预检" : text(value);
}

function lifecycleNextActionReadout(lifecyclePool: Record<string, unknown>): string {
  if (lifecyclePool.next_action) return text(lifecyclePool.next_action);
  if (lifecyclePool.status === "pass") return "等待状态上报；下一步查看推荐任务。";
  return "--";
}

function schedulerRecoveryReadout(value: unknown): string {
  const normalized = String(value || "").trim();
  if (normalized === "ready") return "就绪";
  if (
    !normalized ||
    normalized === "not_configured" ||
    normalized === "idle" ||
    normalized === "no_next_action" ||
    normalized === "wait_for_new_work" ||
    normalized === "no_dispatchable_scheduler_actions"
  ) {
    return "空闲，等待可派发任务";
  }
  return translatedStatus(normalized);
}

function schedulerResumeReadout(value: unknown): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized === "not_configured") {
    return "该通道未启用；无阻塞时继续主任务。";
  }
  return translatedStatus(normalized);
}

function projectionIdFrom(projection: ProjectionResponse | null): string | null {
  const record = asRecord(projection);
  return text(record.projection_id || "current-session", "current-session");
}

export default function OperationPanel({ projection, onProjectionChange }: OperationPanelProps) {
  const [eventControlsEnabled, setEventControlsEnabled] = useState(false);
  const [activeProjection, setActiveProjection] = useState<ProjectionResponse | null>(projection);
  const [projectionId, setProjectionId] = useState<string | null>(projectionIdFrom(projection));
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [buttonText, setButtonText] = useState<Record<string, string>>({});

  useEffect(() => {
    setActiveProjection(projection);
    setProjectionId(projectionIdFrom(projection));
  }, [projection]);

  useEffect(() => {
    const params = new URLSearchParams(globalThis.location?.search || "");
    setEventControlsEnabled(params.get("workbench_event_controls") === "1");
  }, []);

  const record = asRecord(activeProjection) as ProjectionRecord;
  const oneScreen = asRecord(record.one_screen);
  const counters = asRecord(oneScreen.counters);
  const schedulerDispatch = asRecord(record.scheduler_dispatch);
  const schedulerLoop = asRecord(record.scheduler_loop);
  const lifecyclePool = asRecord(record.agent_lifecycle_pool);
  const providerHealth = asRecord(record.reviewer_provider_health);
  const nextAction = asRecord(record.next_action_readout);
  const terminalAction = asRecord(record.next_action_terminal);
  const globalGoals = asRecord(record.global_goal_completion);
  const timelineRecord = asRecord(record.operations_timeline);
  const timeline = Array.isArray(record.operations_timeline)
    ? record.operations_timeline as Array<Record<string, unknown>>
    : (Array.isArray(timelineRecord.items) ? timelineRecord.items as Array<Record<string, unknown>> : []);
  const shardReview = asRecord(record.reviewer_shard_review || record.reviewer_scope_split);

  const operationRows = useMemo(() => timeline.slice(-6), [timeline]);

  if (!eventControlsEnabled) return null;

  async function runMutation(
    actionKey: string,
    pendingLabel: string,
    successLabel: string,
    failureLabel: string,
    fn: () => Promise<unknown>
  ) {
    setBusyAction(actionKey);
    setButtonText((current) => ({ ...current, [actionKey]: pendingLabel }));
    try {
      const payload = await fn();
      const nextProjection = projectionFromMutation(payload as Record<string, unknown>);
      if (nextProjection) {
        setActiveProjection(nextProjection);
        onProjectionChange(nextProjection);
      }
      const nextId = nextProjectionIdFromMutation(payload as Record<string, unknown>);
      if (nextId) setProjectionId(nextId);
      setButtonText((current) => ({ ...current, [actionKey]: successLabel }));
      return payload;
    } catch (error) {
      setButtonText((current) => ({ ...current, [actionKey]: failureLabel }));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function handleValidate() {
    await runMutation("validate", "校验中", "已校验", "事件写入失败", async () => recordOperatorEvent({
      action: "validate",
      run_id: text(record.run_id, "current-run"),
      cycle_id: text(record.cycle_id, "current-cycle"),
      projection_id: projectionId,
      created_at: new Date().toISOString()
    }));
  }

  async function handleProviderHealth(status: "pass" | "timeout") {
    await runMutation(`provider-${status}`, "连通写入中", "连通已记录", "连通写入失败", () => recordProviderHealth({
      smoke_status: status,
      tools: ["Read", "Grep"],
      created_at: new Date().toISOString()
    }));
  }

  async function handleSchedulerDispatch(mode: "dry-run" | "approved-mock") {
    await runMutation(`dispatch-${mode}`, "调度中", "调度已记录", "调度失败", () => runSchedulerDispatch(
      mode === "approved-mock"
        ? { execution_profile: "approved_mock_non_dry_run", created_at: new Date().toISOString() }
        : { dry_run: true, created_at: new Date().toISOString() }
    ));
  }

  async function handleNextAction() {
    const action = text(nextAction.action || oneScreen.recommended_action, "");
    await runMutation("next-action", "推荐动作执行中", "推荐动作已记录", "推荐动作被拦截", () => runNextAction(projectionId, {
      expected_action: action,
      max_iterations: 1,
      execution_profile: "approved_mock_non_dry_run",
      snapshot_id: `workbench-next-${Date.now()}`,
      snapshot_prefix: "workbench-next-loop",
      created_at: new Date().toISOString()
    }));
  }

  async function handleSchedulerLoop(mode: "bounded" | "projected-mock" | "projected-real") {
    const projectedMock = mode === "projected-mock";
    const projectedReal = mode === "projected-real";
    await runMutation(
      `loop-${mode}`,
      projectedMock || projectedReal ? "按投影推进中" : "调度轮次运行中",
      projectedMock || projectedReal ? "投影推进已记录" : "调度轮次已记录",
      projectedReal ? "受控审查被拦截" : "调度轮次失败",
      () => (
      runAutonomousSchedulerLoop(projectionId, {
        max_iterations: projectedMock ? 2 : 1,
        execution_profile: projectedReal ? "approved_bounded_real_reviewer" : "approved_mock_non_dry_run",
        execution_strategy: projectedMock || projectedReal ? "projected_next_action" : "scheduler_dispatch_chain",
        reviewer_mock_status: projectedMock ? "pass" : undefined,
        max_external_reviewer_calls: projectedReal ? 1 : undefined,
        provider_cost_mode: projectedReal ? "bounded" : undefined,
        timeout_seconds: projectedReal ? 90 : undefined,
        budget_tier: projectedReal ? "medium" : undefined,
        snapshot_prefix: projectedMock ? "workbench-projected-loop" : "workbench-loop",
        created_at: new Date().toISOString()
      })
    ));
  }

  async function handleResumeLoop() {
    await runMutation("loop-resume", "续跑调度中", "续跑已记录", "续跑失败", () => resumeAutonomousSchedulerLoop(projectionId, {
      max_iterations: 1,
      execution_profile: "approved_mock_non_dry_run",
      snapshot_prefix: "workbench-resume",
      created_at: new Date().toISOString()
    }));
  }

  return (
    <Card
      title={
        <Space>
          <ApiOutlined />
          <span>运行操作</span>
        </Space>
      }
      size="small"
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Row gutter={[8, 8]}>
          <Col xs={12} md={6}>
            <Button
              block
              icon={<CheckCircleOutlined />}
              loading={busyAction === "validate"}
              data-action="validate"
              onClick={handleValidate}
            >
              {buttonText.validate || "校验"}
            </Button>
          </Col>
          <Col xs={12} md={6}>
            <Button
              block
              loading={busyAction === "provider-timeout"}
              data-provider-health="timeout"
              onClick={() => handleProviderHealth("timeout")}
            >
              {buttonText["provider-timeout"] || "Smoke Timeout"}
            </Button>
          </Col>
          <Col xs={12} md={6}>
            <Button
              block
              loading={busyAction === "dispatch-dry-run"}
              data-scheduler-dispatch="dry-run"
              onClick={() => handleSchedulerDispatch("dry-run")}
            >
              {buttonText["dispatch-dry-run"] || "Dry run"}
            </Button>
          </Col>
          <Col xs={12} md={6}>
            <Button
              block
              loading={busyAction === "dispatch-approved-mock"}
              data-scheduler-dispatch="approved-mock"
              onClick={() => handleSchedulerDispatch("approved-mock")}
            >
              {buttonText["dispatch-approved-mock"] || "Approved mock"}
            </Button>
          </Col>
        </Row>
        <Row gutter={[8, 8]}>
          <Col xs={12} md={6}>
            <Button
              block
              icon={<PlayCircleOutlined />}
              loading={busyAction === "next-action"}
              data-workbench-next-action="guarded"
              onClick={handleNextAction}
            >
              {buttonText["next-action"] || "推荐动作"}
            </Button>
          </Col>
          <Col xs={12} md={6}>
            <Button
              block
              loading={busyAction === "loop-bounded"}
              data-autonomous-scheduler-loop="bounded"
              onClick={() => handleSchedulerLoop("bounded")}
            >
              {buttonText["loop-bounded"] || "调度轮次"}
            </Button>
          </Col>
          <Col xs={12} md={6}>
            <Button
              block
              loading={busyAction === "loop-projected-mock"}
              data-autonomous-scheduler-loop="projected-mock"
              onClick={() => handleSchedulerLoop("projected-mock")}
            >
              {buttonText["loop-projected-mock"] || "投影推进"}
            </Button>
          </Col>
          <Col xs={12} md={6}>
            <Button
              block
              loading={busyAction === "loop-projected-real"}
              data-autonomous-scheduler-loop="projected-real"
              onClick={() => handleSchedulerLoop("projected-real")}
            >
              {buttonText["loop-projected-real"] || "受控审查"}
            </Button>
          </Col>
          <Col xs={12} md={6}>
            <Button
              block
              icon={<SyncOutlined />}
              loading={busyAction === "loop-resume"}
              data-autonomous-scheduler-loop-resume="bounded"
              onClick={handleResumeLoop}
            >
              {buttonText["loop-resume"] || "续跑"}
            </Button>
          </Col>
        </Row>
        <Descriptions column={{ xs: 1, md: 3 }} size="small" colon={false}>
          <Descriptions.Item label="Provider">
            <Tag data-next-readout="provider_health_value">
              {text(providerHealth.provider_health || providerHealth.status || providerHealth.smoke_status)}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Provider next">
            <Text data-next-readout="provider_next_action">{text(providerHealth.next_action)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="调度状态">
            <Tag data-next-readout="scheduler_dispatch_status">{translatedStatus(schedulerDispatch.status)}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="调度步数">
            <Text data-next-readout="scheduler_dispatch_steps">{text(schedulerDispatch.step_count, "0")}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Dry run">
            <Text data-next-readout="scheduler_dispatch_dry_run">{translatedBool(schedulerDispatch.dry_run)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="策略">
            <Text data-next-readout="scheduler_policy_status">{translatedStatus(schedulerDispatch.policy_status)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="策略模式">
            <Text data-next-readout="scheduler_policy_mode">{translatedExecutionMode(schedulerDispatch.policy_execution_mode)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="续跑">
            <Text data-next-readout="scheduler_continuation_ready">
              {count(counters.scheduler_continuation_ready) > 0 ? "就绪" : translatedStatus(schedulerDispatch.continuation_status)}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="循环">
            <Tag data-next-readout="scheduler_loop_status">{translatedStatus(schedulerLoop.status)}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="循环次数">
            <Text data-next-readout="scheduler_loop_iterations">{text(schedulerLoop.iteration_count, "0")}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="循环策略">
            <Text data-next-readout="scheduler_loop_strategy">{translatedStrategy(schedulerLoop.execution_strategy)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="循环恢复">
            <Text data-next-readout="scheduler_loop_recovery">{schedulerRecoveryReadout(schedulerLoop.recovery_status)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Resume">
            <Text data-next-readout="scheduler_loop_resume_status">{schedulerResumeReadout(schedulerLoop.latest_resume_status)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="推荐动作">
            <Text data-next-readout="next_action_readout_action">{text(nextAction.action)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="终止动作">
            <Text data-next-readout="next_action_terminal_action">{text(terminalAction.action || schedulerLoop.terminal_action)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="终止状态">
            <Text data-next-readout="next_action_terminal_status">{translatedStatus(terminalAction.status || schedulerLoop.phase)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="终止原因">
            <Text data-next-readout="next_action_terminal_reason">{text(terminalAction.reason || schedulerLoop.terminal_reason)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Agent 状态">
            <Tag data-next-readout="agent_lifecycle_pool_status">{translatedStatus(lifecyclePool.status)}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Agent open">
            <Text data-next-readout="agent_lifecycle_pool_open">{text(lifecyclePool.open, "0")}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Agent unevaluated">
            <Text data-next-readout="agent_lifecycle_pool_unevaluated">{text(lifecyclePool.unevaluated, "0")}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Agent unclosed">
            <Text data-next-readout="agent_lifecycle_pool_unclosed">{text(lifecyclePool.unclosed, "0")}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Agent timeout">
            <Text data-next-readout="agent_lifecycle_pool_timed_out">{text(lifecyclePool.timed_out, "0")}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Agent heartbeat">
            <Text data-next-readout="agent_lifecycle_pool_heartbeats">{text(lifecyclePool.heartbeat_count, "0")}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Latest heartbeat">
            <Text data-next-readout="agent_lifecycle_pool_latest_heartbeat">{text(lifecyclePool.latest_heartbeat_at)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Latest timeout">
            <Text data-next-readout="agent_lifecycle_pool_latest_timeout">{text(lifecyclePool.latest_timeout_at)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Agent next">
            <Text data-next-readout="agent_lifecycle_pool_next_action">{lifecycleNextActionReadout(lifecyclePool)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Shard status">
            <Text data-next-readout="shard_review_status">{translatedStatus(shardReview.status)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Shard completed">
            <Text data-next-readout="shard_review_completed">{text(shardReview.completed_shards, "0")}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Shard next">
            <Text data-next-readout="shard_review_next">{text(shardReview.next_shard)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Executor">
            <Text data-next-readout="shard_review_executor">{text(shardReview.latest_executor_kind)}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Budget">
            <Text data-next-readout="shard_review_budget">{text(shardReview.latest_external_call_budget_used, "0")}</Text>
          </Descriptions.Item>
        </Descriptions>
        <Row gutter={[8, 8]}>
          <Col xs={12} md={6}>
            <Statistic title="目标完成" value={count(globalGoals.completed)} />
            <Text data-next-readout="global_goals_completed">{count(globalGoals.completed)}</Text>
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="目标总数" value={count(globalGoals.total)} />
            <Text data-next-readout="global_goals_total">{count(globalGoals.total)}</Text>
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="目标阻塞" value={count(globalGoals.blocked)} />
            <Text data-next-readout="global_goals_blocked">{count(globalGoals.blocked)}</Text>
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="运营事件" value={count(counters.operation_events || operationRows.length)} />
            <Text data-next-readout="counter_operation_events">{count(counters.operation_events || operationRows.length)}</Text>
          </Col>
        </Row>
        <Space direction="vertical" size={4} style={{ width: "100%" }} data-next-list="operations_timeline">
          {operationRows.map((event, index) => (
            <Card size="small" key={String(event.id || index)}>
              <Text strong>{text(event.type || event.action)}</Text>
              <br />
              <Text type="secondary">{text(event.created_at || event.timestamp)}</Text>
            </Card>
          ))}
        </Space>
      </Space>
    </Card>
  );
}
