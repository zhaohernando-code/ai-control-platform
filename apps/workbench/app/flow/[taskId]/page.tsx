"use client";

import { AppstoreOutlined, ArrowLeftOutlined } from "@ant-design/icons";
import { Button, Card, Descriptions, Space, Tag, Typography } from "antd";
import { useRouter } from "next/navigation";

const { Title, Paragraph, Text } = Typography;

export default function FlowTaskDetailPage({
  params
}: {
  params: { taskId: string };
}) {
  const router = useRouter();
  const taskId = decodeURIComponent(params.taskId || "");

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/flow")}>
            返回任务流
          </Button>
          <Title level={4} style={{ margin: 0 }}>
            <AppstoreOutlined style={{ marginRight: 8 }} />
            任务详情
          </Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            该页面由 Next.js App Router 动态路由渲染，不依赖预先生成的静态 HTML。
          </Paragraph>
        </Space>
      </Card>
      <Card>
        <Descriptions column={1} bordered size="middle">
          <Descriptions.Item label="任务 ID">
            <Text code>{taskId}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="路由能力">
            <Tag color="green">App Router dynamic route</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="服务方式">
            Next.js runtime
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </Space>
  );
}
