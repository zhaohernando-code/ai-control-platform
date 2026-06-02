"use client";

import { useEffect, useState } from "react";

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Skeleton,
  Space,
  Statistic,
  Tag,
  Timeline,
  Typography
} from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  ExperimentOutlined,
  FileProtectOutlined,
  ProjectOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SyncOutlined
} from "@ant-design/icons";

import OperationPanel from "./operation-panel";
import { useProjection } from "@/lib/hooks";
import type { ProjectionResponse } from "@/lib/api/projection";

const { Title, Text, Paragraph } = Typography;

/* ---------- 语义辅助 ---------- */

const STATUS_COLOR_MAP: Record<string, string> = {
  pass: "green",
  ready: "green",
  available: "green",
  complete: "green",
  completed: "green",
  fail: "red",
  rerun: "orange",
  blocked: "red",
  idle: "default",
  unknown: "default"
};

const STATUS_ICON_MAP: Record<string, React.ReactNode> = {
  pass: <CheckCircleOutlined />,
  ready: <CheckCircleOutlined />,
  complete: <CheckCircleOutlined />,
  fail: <CloseCircleOutlined />,
  rerun: <SyncOutlined spin />,
  blocked: <ExclamationCircleOutlined />,
  idle: <ClockCircleOutlined />
};

function statusColor(value: unknown): string {
  const normalized = String(value ?? "").toLowerCase();
  return STATUS_COLOR_MAP[normalized] ?? "default";
}

function statusIcon(value: unknown): React.ReactNode {
  const normalized = String(value ?? "").toLowerCase();
  return STATUS_ICON_MAP[normalized] ?? undefined;
}

function safeText(value: unknown, fallback = "--"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function safeCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/* ---------- 主组件 ---------- */

/**
 * 总览首屏 —— 对接 `/api/workbench/projection` 的真实数据。
 *
 * - 使用 useProjection hook 轮询拉取一屏 projection，并以 antd
 *   Card / Statistic / Timeline / Tag / Descriptions / Alert 渲染。
 * - 严格按照 FRONTEND_REFACTOR_CONSTRAINTS.md：不写裸 div 排版、
 *   不用自定义 CSS、所有基础组件来自 antd。
 * - 加载中显示 Skeleton，加载失败显示 Alert + 重试按钮。
 * - 旧入口 desktop.html / mobile.html 保留为回退路径。
 */
export default function OverviewPage() {
  const { projection, loading, error, refresh } = useProjection({
    pollIntervalMs: 10000,
    immediate: true
  });
  const [activeProjection, setActiveProjection] = useState<ProjectionResponse | null>(projection);

  useEffect(() => {
    setActiveProjection(projection);
  }, [projection]);

  /* ---- 加载态 ---- */
  if (loading && !projection) {
    return (
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Card>
          <Skeleton active paragraph={{ rows: 2 }} />
        </Card>
        <Row gutter={[16, 16]}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Col key={i} xs={12} sm={8} md={8} lg={4}>
              <Card>
                <Skeleton active paragraph={{ rows: 1 }} />
              </Card>
            </Col>
          ))}
        </Row>
      </Space>
    );
  }

  /* ---- 错误态 ---- */
  if (error && !projection) {
    return (
      <Alert
        showIcon
        type="error"
        message="无法加载工作台状态"
        description={error.message}
        action={
          <Button size="small" danger onClick={refresh}>
            重试
          </Button>
        }
      />
    );
  }

  /* ---- 真实数据渲染 ---- */
  const projectionRecord = asRecord(activeProjection);
  const oneScreen = asRecord(projectionRecord.one_screen);
  const counters = asRecord(oneScreen.counters);
  const closeout = asRecord(projectionRecord.closeout);
  const nextActions = Array.isArray(oneScreen.next_actions)
    ? oneScreen.next_actions as Array<Record<string, unknown>>
    : [];
  const manifest = asRecord(projectionRecord.manifest);
  const events = Array.isArray(manifest.events)
    ? manifest.events as Array<Record<string, unknown>>
    : [];

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>

      {/* ====== Hero 主状态 ====== */}
      <Card>
        <Title level={3} style={{ marginTop: 0, marginBottom: 8 }}>
          <Tag color={statusColor(oneScreen?.primary_status ?? activeProjection?.status)}>
            {safeText(oneScreen?.primary_status ?? activeProjection?.status, "状态未知")}
          </Tag>
          <span style={{ marginLeft: 8 }}>项目总览</span>
        </Title>
        <Paragraph ellipsis={{ rows: 2, expandable: true }} style={{ marginBottom: 8 }}>
          {safeText(activeProjection?.goal, safeText(oneScreen?.headline, "等待状态投影"))}
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Run {safeText(activeProjection?.run_id)} · Cycle {safeText(activeProjection?.cycle_id)}
        </Paragraph>
      </Card>

      {/* ====== 核心指标 ====== */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={8} lg={4}>
          <Card size="small">
            <Statistic
              title="项目总数"
              value={safeCount(counters.projects_total)}
              prefix={<ProjectOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={8} lg={4}>
          <Card size="small">
            <Statistic
              title="活跃项目"
              value={safeCount(counters.active_projects)}
              valueStyle={{ color: safeCount(counters.active_projects) > 0 ? "#1677ff" : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={8} lg={4}>
          <Card size="small">
            <Statistic
              title="任务包"
              value={safeCount(counters.work_packages)}
              prefix={<FileProtectOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={8} lg={4}>
          <Card size="small">
            <Statistic
              title="已完成目标"
              value={`${safeCount(counters.global_goals_completed)}/${safeCount(counters.global_goals_total)}`}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={8} lg={4}>
          <Card size="small">
            <Statistic
              title="运营事件"
              value={safeCount(counters.operation_events)}
              prefix={<ExperimentOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={8} lg={4}>
          <Card size="small">
            <Statistic
              title="证据"
              value={safeCount(counters.artifacts)}
              prefix={<SafetyCertificateOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* ====== Closeout 状态 + 下一步动作 ====== */}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card
            title={
              <Space>
                <SafetyCertificateOutlined />
                <span>收口验收</span>
              </Space>
            }
            size="small"
          >
            <Descriptions column={1} size="small" colon={false}>
              <Descriptions.Item label="状态">
                <Tag color={statusColor(closeout?.status)} icon={statusIcon(closeout?.status)}>
                  {safeText(closeout?.status, "等待上报")}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="快照">
                <Text>{safeText(closeout?.snapshot_id, "无")}</Text>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            title={
              <Space>
                <ReloadOutlined />
                <span>推荐动作</span>
              </Space>
            }
            size="small"
          >
            {nextActions.length > 0 ? (
              <Descriptions column={1} size="small" colon={false}>
                {nextActions.map(
                  (action, idx) => (
                    <Descriptions.Item key={String(action.id ?? idx)} label={safeText(action.action)}>
                      {safeText(action.title)}
                    </Descriptions.Item>
                  )
                )}
              </Descriptions>
            ) : (
              <Text type="secondary">{safeText(oneScreen?.recommended_action, "等待新的可执行任务")}</Text>
            )}
          </Card>
        </Col>
      </Row>

      {/* ====== Agent 生命周期 + 调度状态 ====== */}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title="Agent 池" size="small">
            <Row gutter={[8, 8]}>
              <Col span={8}>
                <Statistic title="开放" value={safeCount(counters.agent_lifecycle_open)} />
              </Col>
              <Col span={8}>
                <Statistic title="未评估" value={safeCount(counters.agent_lifecycle_unevaluated)} />
              </Col>
              <Col span={8}>
                <Statistic title="未关闭" value={safeCount(counters.agent_lifecycle_unclosed)} />
              </Col>
              <Col span={8}>
                <Statistic title="超时" value={safeCount(counters.agent_lifecycle_timed_out)} />
              </Col>
              <Col span={8}>
                <Statistic title="心跳" value={safeCount(counters.agent_lifecycle_heartbeats)} />
              </Col>
              <Col span={8}>
                <Statistic title="已完成" value={safeCount(counters.agent_lifecycle_completed)} />
              </Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="调度" size="small">
            <Row gutter={[8, 8]}>
              <Col span={8}>
                <Statistic title="调度步数" value={safeCount(counters.scheduler_dispatch_steps)} />
              </Col>
              <Col span={8}>
                <Statistic title="续跑就绪" value={safeCount(counters.scheduler_continuation_ready)} />
              </Col>
              <Col span={8}>
                <Statistic title="循环迭代" value={safeCount(counters.scheduler_loop_iterations)} />
              </Col>
              <Col span={8}>
                <Statistic title="审查分片" value={safeCount(counters.reviewer_scope_shards)} />
              </Col>
              <Col span={8}>
                <Statistic title="审查发现" value={safeCount(counters.reviewer_findings)} />
              </Col>
              <Col span={8}>
                <Statistic title="可派发任务" value={safeCount(counters.dispatchable_tasks)} />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <OperationPanel
        projection={activeProjection}
        onProjectionChange={setActiveProjection}
      />

      {/* ====== 治理 ====== */}
      <Card title="治理" size="small">
        <Row gutter={[8, 8]}>
          <Col span={6}>
            <Statistic title="自治理发现" value={safeCount(counters.self_governance_findings)} />
          </Col>
          <Col span={6}>
            <Statistic title="自修复" value={safeCount(counters.self_governance_auto_repairs)} />
          </Col>
          <Col span={6}>
            <Statistic title="证据任务" value={safeCount(counters.self_governance_evidence_tasks)} />
          </Col>
          <Col span={6}>
            <Statistic title="用户决策" value={safeCount(counters.self_governance_user_decisions)} />
          </Col>
        </Row>
      </Card>

      {/* ====== 运行时间线 ====== */}
      <Card title="运行时间线" size="small">
        {events.length > 0 ? (
          <Timeline
            items={events
              .slice(-8)
              .map((event) => ({
                color: statusColor(event.status ?? event.type),
                children: (
                  <Space direction="vertical" size={0}>
                    <Text strong>{safeText(event.type)}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {safeText(event.timestamp ?? event.created_at)}
                    </Text>
                  </Space>
                )
              }))}
          />
        ) : (
          <Text type="secondary">暂无运行事件</Text>
        )}
      </Card>

      {/* ====== 数据更新时间 + 刷新按钮 ====== */}
      <Card size="small">
        <Space>
          <Text type="secondary">
            数据更新时间：{safeText(activeProjection?.generated_at, "未知")}
          </Text>
          <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>
            刷新
          </Button>
          {error && (
            <Tag color="orange">
              轮询出错：{error.message}
            </Tag>
          )}
        </Space>
      </Card>
    </Space>
  );
}
