"use client";

import {
  AppstoreOutlined,
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Empty,
  Grid,
  Input,
  List,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { PlanReviewDrawer } from "./plan-review-drawer";
import { closeRequirementTask, retryRequirementPlan, runContextWorkPackages } from "@/lib/api/requirements";
import { useProjection } from "@/lib/hooks";
import {
  TASK_STATUS_COLOR,
  type TaskFlowItem,
  formatBeijingDateTime,
  isPendingExecutionTask,
  isRecoverablePlanTask,
  recoveryActionLabel,
  safeText,
  taskDetailHref,
  taskItemsFromProjection
} from "@/lib/task-flow";

const { Title, Paragraph, Text } = Typography;
const { useBreakpoint } = Grid;

const STATUS_FILTERS = [
  { label: "全部", value: "all" },
  { label: "运行中", value: "running" },
  { label: "待执行", value: "pending_execution" },
  { label: "待生成", value: "pending_plan_generation" },
  { label: "待审视", value: "pending_review" },
  { label: "完成", value: "completed" },
  { label: "失败", value: "failed" },
  { label: "超时", value: "timeout" }
];

export default function FlowPage() {
  const router = useRouter();
  const { projection, loading, error, refresh } = useProjection({
    pollIntervalMs: 10000,
    immediate: true
  });
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [reviewTask, setReviewTask] = useState<TaskFlowItem | null>(null);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const screens = useBreakpoint();
  const tasks = taskItemsFromProjection(projection);
  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return tasks.filter((task) => {
      const statusMatches = status === "all" || task.status === status;
      const text = [
        task.title,
        task.project_id,
        task.project_name,
        task.status_label,
        task.phase_label
      ].map((value) => safeText(value, "").toLowerCase()).join(" ");
      return statusMatches && (!normalizedQuery || text.includes(normalizedQuery));
    });
  }, [tasks, query, status]);

  const handleRetryPlan = async (task: TaskFlowItem) => {
    setActionError(null);
    setActionTaskId(task.task_id);
    try {
      await retryRequirementPlan({
        requirement_id: task.task_id,
        created_at: new Date().toISOString()
      });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "计划生成重试失败");
    } finally {
      setActionTaskId(null);
    }
  };

  const handleResumeExecution = async (task: TaskFlowItem) => {
    setActionError(null);
    setActionTaskId(task.task_id);
    try {
      await runContextWorkPackages({
        max_package_count: 1,
        dispatch_mode: "background",
        background: true,
        created_at: new Date().toISOString()
      });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "恢复执行失败");
    } finally {
      setActionTaskId(null);
    }
  };

  const handleCloseFailedTask = (task: TaskFlowItem) => {
    Modal.confirm({
      title: "关闭任务",
      content: `关闭后「${safeText(task.title)}」不再阻塞任务流，可从历史记录继续查看。`,
      okText: "关闭任务",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setActionError(null);
        setActionTaskId(task.task_id);
        try {
          await closeRequirementTask({
            requirement_id: task.task_id,
            note: "operator closed failed task from task flow",
            created_at: new Date().toISOString()
          });
          refresh();
        } catch (err) {
          setActionError(err instanceof Error ? err.message : "关闭任务失败");
          throw err;
        } finally {
          setActionTaskId(null);
        }
      }
    });
  };

  const columns: ColumnsType<TaskFlowItem> = [
    {
      title: "任务标题",
      dataIndex: "title",
      key: "title",
      width: 190,
      render: (_, task) => (
        <Space direction="vertical" size={0}>
          <Text strong>{safeText(task.title)}</Text>
        </Space>
      )
    },
    {
      title: "所属项目",
      dataIndex: "project_name",
      key: "project_name",
      width: 130,
      render: (_, task) => safeText(task.project_name || task.project_id)
    },
    {
      title: "当前状态",
      dataIndex: "status_label",
      key: "status_label",
      width: 105,
      render: (_, task) => (
        <Tag color={TASK_STATUS_COLOR[safeText(task.status, "")] || "default"}>
          {safeText(task.status_label)}
        </Tag>
      )
    },
    {
      title: "当前阶段",
      dataIndex: "phase_label",
      key: "phase_label",
      width: 120,
      render: (_, task) => safeText(task.phase_label)
    },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      key: "updated_at",
      width: 185,
      render: (_, task) => (
        <Text style={{ whiteSpace: "nowrap" }}>
          {formatBeijingDateTime(task.updated_at || task.submitted_at)}
        </Text>
      )
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 196,
      render: (_, task) => (
        <Space wrap size={8}>
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => router.push(taskDetailHref(task.task_id))}
          >
            详情
          </Button>
          {task.reviewable && (
            <Button size="small" type="primary" onClick={() => setReviewTask(task)}>
              计划审视
            </Button>
          )}
          {isPendingExecutionTask(task) && (
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={actionTaskId === task.task_id}
              onClick={() => handleResumeExecution(task)}
            >
              恢复执行
            </Button>
          )}
          {isRecoverablePlanTask(task) && (
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={actionTaskId === task.task_id}
              onClick={() => handleRetryPlan(task)}
            >
              {recoveryActionLabel(task)}
            </Button>
          )}
          {isRecoverablePlanTask(task) && (
            <Button
              size="small"
              danger
              loading={actionTaskId === task.task_id}
              onClick={() => handleCloseFailedTask(task)}
            >
              关闭
            </Button>
          )}
        </Space>
      )
    }
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Title level={4} style={{ margin: 0 }}>
            <AppstoreOutlined style={{ marginRight: 8 }} />
            任务流
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            任务创建后的计划生成、人工审视、执行、失败和验收状态都在这里跟踪。
          </Paragraph>
        </Space>
      </Card>
      {error && (
        <Alert
          showIcon
          type="error"
          message="任务流加载失败"
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
      <Card>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space wrap>
            <Segmented
              options={STATUS_FILTERS}
              value={status}
              onChange={(value) => setStatus(String(value))}
            />
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索任务、项目或阶段"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ width: 280 }}
            />
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
          </Space>
          {screens.md ? (
            <Table
              rowKey="task_id"
              columns={columns}
              dataSource={filteredTasks}
              loading={loading && tasks.length === 0}
              pagination={{ pageSize: 8, showSizeChanger: false }}
              scroll={{ x: 926 }}
              locale={{ emptyText: <Empty description="暂无任务" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          ) : (
            <List
              dataSource={filteredTasks}
              loading={loading && tasks.length === 0}
              locale={{ emptyText: <Empty description="暂无任务" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              renderItem={(task) => {
                const actions = [
                  <Button key="detail" size="small" onClick={() => router.push(taskDetailHref(task.task_id))}>
                    详情
                  </Button>
                ];
                if (task.reviewable) {
                  actions.push(
                    <Button key="review" size="small" type="primary" onClick={() => setReviewTask(task)}>
                      计划审视
                    </Button>
                  );
                }
                if (isPendingExecutionTask(task)) {
                  actions.push(
                    <Button
                      key="resume"
                      size="small"
                      loading={actionTaskId === task.task_id}
                      onClick={() => handleResumeExecution(task)}
                    >
                      恢复执行
                    </Button>
                  );
                }
                if (isRecoverablePlanTask(task)) {
                  actions.push(
                    <Button
                      key="retry"
                      size="small"
                      loading={actionTaskId === task.task_id}
                      onClick={() => handleRetryPlan(task)}
                    >
                      {recoveryActionLabel(task)}
                    </Button>,
                    <Button
                      key="close"
                      size="small"
                      danger
                      loading={actionTaskId === task.task_id}
                      onClick={() => handleCloseFailedTask(task)}
                    >
                      关闭
                    </Button>
                  );
                }
                return (
                  <List.Item actions={actions}>
                    <List.Item.Meta
                      title={
                        <Space wrap>
                          <Text strong>{safeText(task.title)}</Text>
                          <Tag color={TASK_STATUS_COLOR[safeText(task.status, "")] || "default"}>
                            {safeText(task.status_label)}
                          </Tag>
                        </Space>
                      }
                      description={`${safeText(task.project_name || task.project_id)} · ${safeText(task.phase_label)} · ${safeText(task.location_label)}`}
                    />
                  </List.Item>
                );
              }}
            />
          )}
        </Space>
      </Card>
      <PlanReviewDrawer
        task={reviewTask}
        open={Boolean(reviewTask)}
        onClose={() => setReviewTask(null)}
        onUpdated={refresh}
      />
    </Space>
  );
}
