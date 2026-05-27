"use client";

import { CheckCircleOutlined, RollbackOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Form,
  Input,
  Space,
  Typography
} from "antd";
import { useState, useTransition } from "react";

import { updatePlanReview } from "@/lib/api/requirements";
import {
  FEEDBACK_CATEGORY_OPTIONS,
  type TaskFlowItem,
  asArray,
  safeText
} from "@/lib/task-flow";

const { Paragraph, Text, Title } = Typography;

export function PlanReviewDrawer({
  task,
  open,
  onClose,
  onUpdated
}: {
  task: TaskFlowItem | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ feedback_categories?: string[]; note?: string }>();
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<"approve" | "revise" | null>(null);
  const planReview = task?.plan_review || {};
  const reviewable = Boolean(task?.reviewable || planReview.reviewable);

  const submitReview = (action: "approve" | "revise") => {
    if (!task?.task_id) return;
    startTransition(async () => {
      setMode(action);
      try {
        const values = await form.validateFields();
        if (
          action === "revise" &&
          !String(values.note || "").trim() &&
          (!Array.isArray(values.feedback_categories) || values.feedback_categories.length === 0)
        ) {
          throw new Error("打回修订需要选择原因或填写反馈");
        }
        await updatePlanReview({
          requirement_id: task.task_id,
          action,
          note: values.note,
          feedback_categories: values.feedback_categories,
          auto_advance_after_plan_review: action === "approve",
          auto_advance_max_iterations: action === "approve" ? 3 : undefined,
          created_at: new Date().toISOString()
        });
        message.success(action === "approve" ? "已同意进入开发" : "已退回修订");
        onUpdated();
        onClose();
      } catch (error) {
        if (error instanceof Error) {
          message.error(error.message);
        }
      } finally {
        setMode(null);
      }
    });
  };

  return (
    <Drawer
      title="计划审视"
      width={640}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button
            icon={<RollbackOutlined />}
            disabled={!reviewable}
            loading={isPending && mode === "revise"}
            onClick={() => submitReview("revise")}
          >
            打回修订
          </Button>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            disabled={!reviewable}
            loading={isPending && mode === "approve"}
            onClick={() => submitReview("approve")}
          >
            同意进入开发
          </Button>
        </Space>
      }
    >
      {!task ? (
        <Alert type="warning" showIcon message="未选择任务" />
      ) : (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Space direction="vertical" size={4}>
            <Title level={4} style={{ margin: 0 }}>
              {safeText(task.title)}
            </Title>
            <Text type="secondary">
              {safeText(task.project_name || task.project_id)} · {safeText(task.phase_label)}
            </Text>
          </Space>
          {!reviewable && (
            <Alert
              type="info"
              showIcon
              message="当前任务还不能审视计划"
              description={safeText(task.status_label, "等待计划生成完成")}
            />
          )}
          <Descriptions column={1} bordered size="small">
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
              <Space direction="vertical">
                {asArray<string>(planReview.implementation_outline).length > 0
                  ? asArray<string>(planReview.implementation_outline).map((step, index) => (
                    <Text key={`${step}-${index}`}>{index + 1}. {step}</Text>
                  ))
                  : <Text type="secondary">暂无实施步骤</Text>}
              </Space>
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
          <Form form={form} layout="vertical">
            <Form.Item
              label="打回原因"
              name="feedback_categories"
            >
              <Checkbox.Group options={[...FEEDBACK_CATEGORY_OPTIONS]} />
            </Form.Item>
            <Form.Item label="反馈" name="note">
              <Input.TextArea
                rows={4}
                placeholder="说明需要补充或调整的地方"
                showCount
                maxLength={600}
              />
            </Form.Item>
          </Form>
        </Space>
      )}
    </Drawer>
  );
}
