"use client";

import { Skeleton, Space } from "antd";

/**
 * App Router loading boundary，使用 antd Skeleton 占位，禁止自造骨架样式。
 */
export default function GlobalLoading() {
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Skeleton active paragraph={{ rows: 4 }} />
      <Skeleton active paragraph={{ rows: 6 }} />
    </Space>
  );
}
