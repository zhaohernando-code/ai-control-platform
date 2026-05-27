"use client";

import { Button, Card, Empty, Space, Typography } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Paragraph } = Typography;

/**
 * Agents（agents）—— 占位页。
 *
 * 后续切片会迁移到 antd Card + Descriptions + List，
 * 展示 Agent 池、活跃任务、model_roles 和生命周期事件。
 */
export default function AgentsPage() {
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          <RobotOutlined style={{ marginRight: 8 }} />
          Agents
        </Title>
        <Paragraph type="secondary">
          此模块将在后续切片中迁移为 antd Card + Descriptions + List，
          展示 Agent 池、活跃任务、模型角色和生命周期事件。
        </Paragraph>
      </Card>
      <Card>
        <Empty
          description="Agents 面板将在后续切片中接入"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Button type="primary" onClick={() => router.push("/")}>
            返回总览
          </Button>
        </Empty>
      </Card>
    </Space>
  );
}
