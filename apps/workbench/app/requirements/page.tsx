"use client";

import { SendOutlined, SolutionOutlined } from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Typography
} from "antd";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { submitRequirement } from "@/lib/api/requirements";
import { useProjection } from "@/lib/hooks";
import { projectsFromProjection } from "@/lib/task-flow";

const { Title, Paragraph, Text } = Typography;

export default function RequirementsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [isPending, startTransition] = useTransition();
  const { projection, loading, error, refresh } = useProjection({
    pollIntervalMs: 0,
    immediate: true
  });
  const projectOptions = projectsFromProjection(projection);

  const submit = (values: {
    title: string;
    project_id: string;
    problem_statement: string;
    constraints?: string;
  }) => {
    startTransition(async () => {
      try {
        const result = await submitRequirement({
          title: values.title,
          project_id: values.project_id,
          surface_area: "platform_project",
          problem_statement: values.problem_statement,
          constraints: values.constraints,
          plan_review_requested: true,
          generate_plan: true,
          plan_generation_mode: "model",
          created_at: new Date().toISOString()
        });
        const taskId = result.requirement?.id;
        message.success("任务已提交，后续步骤已进入任务流");
        form.resetFields();
        if (taskId) {
          router.push(`/flow/${encodeURIComponent(taskId)}`);
        } else {
          router.push("/flow");
        }
      } catch (submitError) {
        message.error(submitError instanceof Error ? submitError.message : "任务提交失败");
      }
    });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Space direction="vertical" size="small">
          <Title level={4} style={{ margin: 0 }}>
            <SolutionOutlined style={{ marginRight: 8 }} />
            新建任务
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            提交后由平台生成计划和验收方案，后续审视、执行与结果都在任务流中处理。
          </Paragraph>
        </Space>
      </Card>
      {error && (
        <Alert
          showIcon
          type="warning"
          message="项目列表加载失败"
          description={error.message}
          action={<Button size="small" onClick={refresh}>重试</Button>}
        />
      )}
      <Card>
        <Form
          form={form}
          layout="vertical"
          requiredMark="optional"
          onFinish={submit}
          initialValues={{ project_id: "ai-control-platform" }}
        >
          <Form.Item
            label="任务标题"
            name="title"
            rules={[{ required: true, message: "请输入任务标题" }]}
          >
            <Input placeholder="例如：接入任务流计划审视" maxLength={80} showCount />
          </Form.Item>
          <Form.Item
            label="所属项目"
            name="project_id"
            rules={[{ required: true, message: "请选择所属项目" }]}
          >
            <Select
              loading={loading}
              options={projectOptions}
              placeholder="选择项目"
            />
          </Form.Item>
          <Form.Item
            label="需求描述"
            name="problem_statement"
            rules={[{ required: true, message: "请说明现状与目标" }]}
          >
            <Input.TextArea
              rows={8}
              placeholder="说明要解决的问题、期望行为、用户可见结果和重要背景"
              maxLength={3000}
              showCount
            />
          </Form.Item>
          <Form.Item label="约束 / 备注" name="constraints">
            <Input.TextArea
              rows={4}
              placeholder="可填写技术约束、不能改变的行为、发布时间或风险提示"
              maxLength={1200}
              showCount
            />
          </Form.Item>
          <Alert
            showIcon
            type="info"
            message="验收方案由平台生成"
            description="具体验收方案会在计划生成后进入任务流。请在计划审视中同意或打回。"
            style={{ marginBottom: 24 }}
          />
          <Space>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SendOutlined />}
              loading={isPending}
            >
              提交
            </Button>
            <Button onClick={() => router.push("/flow")}>查看任务流</Button>
            <Text type="secondary">创建成功后会自动进入任务详情。</Text>
          </Space>
        </Form>
      </Card>
    </Space>
  );
}
