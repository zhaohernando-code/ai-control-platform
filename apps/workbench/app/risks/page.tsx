"use client";

import { Button, Card, Empty, Space, Typography } from "antd";
import { WarningOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Paragraph } = Typography;

/**
 * 风险（risks）—— 占位页。
 *
 * 后续切片会迁移到 antd Alert + Card + Descriptions，
 * 展示阻塞项、风险摘要和需要人工决策的事项。
 */
export default function RisksPage() {
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          <WarningOutlined style={{ marginRight: 8 }} />
          风险
        </Title>
        <Paragraph type="secondary">
          此模块将在后续切片中迁移为 antd Alert + Card + Descriptions，
          展示阻塞项、风险摘要和需要人工决策的事项。
        </Paragraph>
      </Card>
      <Card>
        <Empty
          description="风险面板将在后续切片中接入"
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
