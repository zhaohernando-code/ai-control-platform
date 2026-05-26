"use client";

import { Alert, Button, Result, Space } from "antd";
import { useEffect } from "react";

/**
 * 全局错误边界，使用 antd Result + Alert + Button，禁止自造样式。
 */
export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (typeof console !== "undefined") {
      console.error("[workbench] render error", error);
    }
  }, [error]);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Result
        status="error"
        title="渲染出错"
        subTitle={error.message}
        extra={<Button onClick={reset}>重试</Button>}
      />
      {error.digest ? (
        <Alert showIcon type="warning" message={`digest: ${error.digest}`} />
      ) : null}
    </Space>
  );
}
