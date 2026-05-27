"use client";

import { Button, Card, Empty, Space, Typography } from "antd";
import { SafetyCertificateOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Paragraph } = Typography;

/**
 * 治理（governance）—— 占位页。
 *
 * 后续切片会迁移到 antd Card + Descriptions + Alert，
 * 展示治理状态、Closeout 证据、Snapshot 和 process-hardening 结果。
 */
export default function GovernancePage() {
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          <SafetyCertificateOutlined style={{ marginRight: 8 }} />
          治理
        </Title>
        <Paragraph type="secondary">
          此模块将在后续切片中迁移为 antd Card + Descriptions + Alert，
          展示治理状态、收口验收证据、Snapshot 和流程硬化结果。
        </Paragraph>
      </Card>
      <Card>
        <Empty
          description="治理面板将在后续切片中接入"
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
