"use client";

import {
  Alert,
  Button,
  Card,
  Empty,
  Modal,
  Progress,
  Row,
  Col,
  Space,
  Statistic,
  Table,
  Tag,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { EyeOutlined, ProjectOutlined, ReloadOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { closeRequirementTask, retryRequirementPlan, runContextWorkPackages } from "@/lib/api/requirements";
import { useProjection } from "@/lib/hooks";
import {
  TASK_STATUS_COLOR,
  type TaskFlowItem,
  asArray,
  asRecord,
  formatBeijingDateTime,
  isPendingExecutionTask,
  isRecoverablePlanTask,
  recoveryActionLabel,
  safeText,
  taskDetailHref,
  taskItemsFromProjection
} from "@/lib/task-flow";

const { Title, Text } = Typography;

interface ProjectRow {
  key: string;
  project_id: string;
  display_name: string;
  status: string;
  phase: string;
  current_task: string;
  owner_agent: string;
  progress: number;
  last_updated: string;
  human_decisions: number;
}

export default function ProjectsPage() {
  const router = useRouter();
  const { projection, loading, error, refresh } = useProjection({
    pollIntervalMs: 10000,
    immediate: true
  });
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const projectManagement = asRecord(asRecord(projection).project_management);
  const taskItems = taskItemsFromProjection(projection);
  const projectRows = useMemo<ProjectRow[]>(() => {
    const projects = asArray<Record<string, unknown>>(projectManagement.projects);
    return projects.map((project) => {
      const projectId = safeText(project.project_id, "ai-control-platform");
      return {
        key: projectId,
        project_id: projectId,
        display_name: safeText(project.display_name || project.project_id),
        status: safeText(project.status, "unknown"),
        phase: safeText(project.phase, "状态确认"),
        current_task: safeText(project.current_task, "等待下一步任务"),
        owner_agent: safeText(project.owner_agent, "main_orchestrator"),
        progress: Number(project.progress || 0),
        last_updated: safeText(project.last_updated, ""),
        human_decisions: Number(project.human_decisions || 0)
      };
    });
  }, [projection]);

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
        created_at: new Date().toISOString()
      });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "恢复执行失败");
    } finally {
      setActionTaskId(null);
    }
  };

  const handleCloseTask = (task: TaskFlowItem) => {
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
            note: "operator closed task from project tab",
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

  const projectColumns: ColumnsType<ProjectRow> = [
    {
      title: "项目",
      dataIndex: "display_name",
      key: "display_name",
      width: 180,
      render: (_, project) => (
        <Space direction="vertical" size={0}>
          <Text strong>{project.display_name}</Text>
          <Text type="secondary">{project.project_id}</Text>
        </Space>
      )
    },
    {
      title: "阶段",
      dataIndex: "phase",
      key: "phase",
      width: 120
    },
    {
      title: "当前任务",
      dataIndex: "current_task",
      key: "current_task",
      ellipsis: true
    },
    {
      title: "进度",
      dataIndex: "progress",
      key: "progress",
      width: 150,
      render: (value) => <Progress percent={Number(value || 0)} size="small" />
    },
    {
      title: "更新时间",
      dataIndex: "last_updated",
      key: "last_updated",
      width: 185,
      render: (_, project) => (
        <Text style={{ whiteSpace: "nowrap" }}>
          {formatBeijingDateTime(project.last_updated)}
        </Text>
      )
    }
  ];

  const taskColumns: ColumnsType<TaskFlowItem> = [
    {
      title: "任务",
      dataIndex: "title",
      key: "title",
      width: 220,
      render: (_, task) => <Text strong>{safeText(task.title)}</Text>
    },
    {
      title: "状态",
      dataIndex: "status_label",
      key: "status_label",
      width: 110,
      render: (_, task) => (
        <Tag color={TASK_STATUS_COLOR[safeText(task.status, "")] || "default"}>
          {safeText(task.status_label)}
        </Tag>
      )
    },
    {
      title: "阶段",
      dataIndex: "phase_label",
      key: "phase_label",
      width: 130,
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
      width: 230,
      render: (_, task) => (
        <Space wrap size={8}>
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => router.push(taskDetailHref(task.task_id))}
          >
            详情
          </Button>
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
              onClick={() => handleCloseTask(task)}
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
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Title level={4} style={{ margin: 0 }}>
            <ProjectOutlined style={{ marginRight: 8 }} />
            项目列表
          </Title>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Statistic title="项目总数" value={Number(projectManagement.projects_total || projectRows.length || 0)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="进行中项目" value={Number(projectManagement.active_projects || 0)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="任务总数" value={Number(projectManagement.tasks_total || taskItems.length || 0)} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="需决策" value={Number(projectManagement.human_decisions || 0)} />
            </Col>
          </Row>
        </Space>
      </Card>
      {error && (
        <Alert
          showIcon
          type="error"
          message="项目列表加载失败"
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
        <Table
          rowKey="project_id"
          columns={projectColumns}
          dataSource={projectRows}
          loading={loading && projectRows.length === 0}
          pagination={false}
          scroll={{ x: 850 }}
          locale={{ emptyText: <Empty description="暂无项目" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        />
      </Card>
      <Card title="项目下的任务">
        <Table
          rowKey="task_id"
          columns={taskColumns}
          dataSource={taskItems}
          loading={loading && taskItems.length === 0}
          pagination={{ pageSize: 6, showSizeChanger: false }}
          scroll={{ x: 875 }}
          locale={{ emptyText: <Empty description="暂无任务" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        />
      </Card>
    </Space>
  );
}
