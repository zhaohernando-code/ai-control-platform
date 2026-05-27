"use client";

import { Button, Card, Empty, Space, Typography } from "antd";
import { AppstoreOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Paragraph } = Typography;

/**
 * 任务流（flow）—— 占位页。
 *
 * 后续切片会迁移到 antd Timeline / Steps + Tag，
 * 展示需求 → 拆解 → 子任务 → Review → 发布 → Live 验证 → 验收链路。
 */
export default function FlowPage() {
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          <AppstoreOutlined style={{ marginRight: 8 }} />
          任务流
        </Title>
        <Paragraph type="secondary">
          此模块将在后续切片中迁移为 antd Timeline + Steps + Tag，
          展示需求 → 拆解 → 子任务 → Review → 发布 → Live 验证 → 验收链路。
        </Paragraph>
      </Card>
      <Card>
        <Empty
          description="任务流将在后续切片中接入"
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
