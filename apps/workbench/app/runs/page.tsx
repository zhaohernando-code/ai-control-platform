"use client";

import { Button, Card, Empty, Space, Typography } from "antd";
import { ExperimentOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Paragraph } = Typography;

/**
 * 运行诊断（runs）—— 占位页。
 *
 * 后续切片会迁移到 antd Card + Descriptions + Timeline，
 * 展示调度、模型、审查、Operator 时间线等运行诊断信息。
 */
export default function RunsPage() {
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          <ExperimentOutlined style={{ marginRight: 8 }} />
          运行诊断
        </Title>
        <Paragraph type="secondary">
          此模块将在后续切片中迁移为 antd Card + Descriptions + Timeline，
          展示调度执行、模型路由、审查通道和 Operator 操作时间线。
        </Paragraph>
      </Card>
      <Card>
        <Empty
          description="运行诊断面板将在后续切片中接入"
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
