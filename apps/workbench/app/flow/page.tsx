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
import { useProjection } from "@/lib/hooks";
import {
  TASK_STATUS_COLOR,
  type TaskFlowItem,
  safeText,
  taskDetailHref,
  taskItemsFromProjection
} from "@/lib/task-flow";

const { Title, Paragraph, Text } = Typography;
const { useBreakpoint } = Grid;

const STATUS_FILTERS = [
  { label: "全部", value: "all" },
  { label: "运行中", value: "running" },
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
        task.phase_label,
        task.location_label
      ].map((value) => safeText(value, "").toLowerCase()).join(" ");
      return statusMatches && (!normalizedQuery || text.includes(normalizedQuery));
    });
  }, [tasks, query, status]);

  const columns: ColumnsType<TaskFlowItem> = [
    {
      title: "任务标题",
      dataIndex: "title",
      key: "title",
      render: (_, task) => (
        <Space direction="vertical" size={0}>
          <Text strong>{safeText(task.title)}</Text>
          <Text type="secondary">{safeText(task.task_id)}</Text>
        </Space>
      )
    },
    {
      title: "所属项目",
      dataIndex: "project_name",
      key: "project_name",
      render: (_, task) => safeText(task.project_name || task.project_id)
    },
    {
      title: "当前状态",
      dataIndex: "status_label",
      key: "status_label",
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
      render: (_, task) => safeText(task.phase_label)
    },
    {
      title: "所在",
      dataIndex: "location_label",
      key: "location_label",
      render: (_, task) => safeText(task.location_label)
    },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      key: "updated_at",
      render: (_, task) => safeText(task.updated_at || task.submitted_at)
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      render: (_, task) => (
        <Space>
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => router.push(taskDetailHref(task.task_id))}
          >
            显示详情
          </Button>
          {task.reviewable && (
            <Button size="small" type="primary" onClick={() => setReviewTask(task)}>
              计划审视
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
              scroll={{ x: 1100 }}
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
