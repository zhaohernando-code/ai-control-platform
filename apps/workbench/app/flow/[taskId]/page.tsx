"use client";

import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  ReloadOutlined
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  List,
  Modal,
  Space,
  Spin,
  Tag,
  Timeline,
  Typography
} from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PlanReviewDrawer } from "../plan-review-drawer";
import { closeRequirementTask, retryRequirementPlan } from "@/lib/api/requirements";
import { useProjection } from "@/lib/hooks";
import {
  TASK_STATUS_COLOR,
  asArray,
  asRecord,
  findTaskById,
  formatBeijingDateTime,
  isRecoverableFailedTask,
  safeText
} from "@/lib/task-flow";

const { Title, Paragraph, Text } = Typography;

export default function FlowTaskDetailPage({
  params
}: {
  params: { taskId: string };
}) {
  const router = useRouter();
  const taskId = decodeURIComponent(params.taskId || "");
  const { projection, loading, error, refresh } = useProjection({
    pollIntervalMs: 10000,
    immediate: true
  });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const task = findTaskById(projection, taskId);
  const planReview = task?.plan_review || {};
  const workPackages = task?.work_packages || [];
  const events = asArray<Record<string, unknown>>(
    asRecord(asRecord(projection).operations_timeline).items
  ).filter((event) => safeText(event.requirement_id || event.global_goal_id || "", "") === taskId);

  const handleRetryPlan = async () => {
    if (!task) return;
    setActionError(null);
    setActionLoading(true);
    try {
      await retryRequirementPlan({
        requirement_id: task.task_id,
        created_at: new Date().toISOString()
      });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "计划生成重试失败");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCloseFailedTask = () => {
    if (!task) return;
    Modal.confirm({
      title: "关闭失败任务",
      content: `关闭后「${safeText(task.title)}」不再阻塞任务流，可从历史记录继续查看。`,
      okText: "关闭任务",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setActionError(null);
        setActionLoading(true);
        try {
          await closeRequirementTask({
            requirement_id: task.task_id,
            note: "operator closed failed task from task detail",
            created_at: new Date().toISOString()
          });
          refresh();
        } catch (err) {
          setActionError(err instanceof Error ? err.message : "关闭任务失败");
          throw err;
        } finally {
          setActionLoading(false);
        }
      }
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/flow")}>
            返回任务流
          </Button>
          <Space wrap>
            <Title level={4} style={{ margin: 0 }}>
              <AppstoreOutlined style={{ marginRight: 8 }} />
              任务详情
            </Title>
            <Tag color="green">App Router dynamic route</Tag>
          </Space>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            该页面由 Next.js App Router 动态路由渲染，展示任务从新建、计划审视到执行的完整状态。
          </Paragraph>
        </Space>
      </Card>
      {error && (
        <Alert
          showIcon
          type="error"
          message="任务详情加载失败"
          description={error.message}
          action={<Button size="small" danger onClick={refresh}>重试</Button>}
        />
      )}
      {actionError && (
        <Alert
          showIcon
          type="error"
          message="任务操作失败"
          description={actionError}
          closable
          onClose={() => setActionError(null)}
        />
      )}
      <Spin spinning={loading && !task}>
        {!task ? (
          <Card>
            <Empty
              description={`未找到任务：${taskId}`}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button onClick={() => router.push("/flow")}>返回任务流</Button>
            </Empty>
          </Card>
        ) : (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card
              title={task.title}
              extra={
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
                  {task.reviewable && (
                    <Button type="primary" onClick={() => setReviewOpen(true)}>
                      计划审视
                    </Button>
                  )}
                  {isRecoverableFailedTask(task) && (
                    <Button
                      icon={<ReloadOutlined />}
                      loading={actionLoading}
                      onClick={handleRetryPlan}
                    >
                      重试计划
                    </Button>
                  )}
                  {isRecoverableFailedTask(task) && (
                    <Button
                      danger
                      loading={actionLoading}
                      onClick={handleCloseFailedTask}
                    >
                      关闭失败任务
                    </Button>
                  )}
                </Space>
              }
            >
              <Descriptions column={{ xs: 1, sm: 1, md: 2 }} bordered size="middle">
                <Descriptions.Item label="任务 ID">
                  <Text code>{task.task_id}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="所属项目">
                  {safeText(task.project_name || task.project_id)}
                </Descriptions.Item>
                <Descriptions.Item label="当前状态">
                  <Tag color={TASK_STATUS_COLOR[safeText(task.status, "")] || "default"}>
                    {safeText(task.status_label)}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="当前阶段">
                  {safeText(task.phase_label)}
                </Descriptions.Item>
                <Descriptions.Item label="所在">
                  {safeText(task.location_label)}
                </Descriptions.Item>
                <Descriptions.Item label="更新时间">
                  {formatBeijingDateTime(task.updated_at || task.submitted_at)}
                </Descriptions.Item>
                <Descriptions.Item label="需求描述" span={2}>
                  <Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
                    {safeText(task.problem_statement || task.summary)}
                  </Paragraph>
                </Descriptions.Item>
                <Descriptions.Item label="约束 / 备注" span={2}>
                  <Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
                    {safeText(task.constraints, "无")}
                  </Paragraph>
                </Descriptions.Item>
                {task.failure_reason && (
                  <Descriptions.Item label="失败原因" span={2}>
                    <Text type="danger">{task.failure_reason}</Text>
                  </Descriptions.Item>
                )}
              </Descriptions>
            </Card>
            <Card title="计划审视">
              <Descriptions column={1} bordered size="small">
                <Descriptions.Item label="审视状态">
                  {safeText(planReview.action_status || task.phase_label)}
                </Descriptions.Item>
                <Descriptions.Item label="评估摘要">
                  <Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
                    {safeText(planReview.assessment_summary, "等待模型生成评估摘要")}
                  </Paragraph>
                </Descriptions.Item>
                <Descriptions.Item label="建议验收方案">
                  <Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
                    {safeText(planReview.proposed_acceptance_plan, "等待模型生成验收方案")}
                  </Paragraph>
                </Descriptions.Item>
                <Descriptions.Item label="实施步骤">
                  <List
                    dataSource={asArray<string>(planReview.implementation_outline)}
                    locale={{ emptyText: "暂无实施步骤" }}
                    renderItem={(item, index) => (
                      <List.Item>{index + 1}. {item}</List.Item>
                    )}
                  />
                </Descriptions.Item>
                <Descriptions.Item label="验收门禁">
                  <Space direction="vertical">
                    {asArray<string>(planReview.acceptance_gates).length > 0
                      ? asArray<string>(planReview.acceptance_gates).map((gate) => (
                        <Text code key={gate}>{gate}</Text>
                      ))
                      : <Text type="secondary">暂无验收门禁</Text>}
                  </Space>
                </Descriptions.Item>
              </Descriptions>
            </Card>
            <Card title="关联工作包">
              <List
                dataSource={workPackages}
                locale={{ emptyText: "暂无工作包" }}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      title={safeText(item.title || item.id)}
                      description={`${safeText(item.action)} · ${safeText(item.status)}`}
                    />
                  </List.Item>
                )}
              />
            </Card>
            <Card title="最近事件">
              {events.length > 0 ? (
                <Timeline
                  items={events.map((event) => ({
                    children: (
                      <Space direction="vertical" size={0}>
                        <Text strong>{safeText(event.type)}</Text>
                        <Text type="secondary">{safeText(event.timestamp || event.created_at)}</Text>
                      </Space>
                    )
                  }))}
                />
              ) : (
                <Text type="secondary">暂无关联事件</Text>
              )}
            </Card>
          </Space>
        )}
      </Spin>
      <PlanReviewDrawer
        task={task}
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onUpdated={refresh}
      />
    </Space>
  );
}
