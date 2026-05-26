"use client";

import { Button, Result } from "antd";
import Link from "next/link";

export default function NotFound() {
  return (
    <Result
      status="404"
      title="404"
      subTitle="所请求的工作台子页未实现，请回到总览。"
      extra={
        <Link href="/">
          <Button type="primary">回到总览</Button>
        </Link>
      }
    />
  );
}
