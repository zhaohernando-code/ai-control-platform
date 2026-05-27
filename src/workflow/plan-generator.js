/**
 * 通用计划生成模块
 * 
 * 当前实现：Claude Code模式
 * 可扩展为：多模型支持、配置化模型选择
 * 
 * 使用者可配置的参数：
 * - modelProvider: 'claude-code' (默认) | 'codex' | 其他
 * - modelConfig: 模型特定的配置
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 通用计划生成接口
 * @param {Object} requirement - 需求对象
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 生成的计划对象
 */
export async function generateRequirementPlan(requirement = {}, options = {}) {
  const provider = options.modelProvider || "claude-code";
  
  if (provider === "claude-code") {
    return generateWithClaudeCode(requirement, options);
  }
  
  // 后续可扩展其他提供者
  throw new Error(`Unsupported model provider: ${provider}`);
}

/**
 * Claude Code 模式实现
 * 使用 claude code 命令行工具调用Claude生成计划
 */
async function generateWithClaudeCode(requirement = {}, options = {}) {
  const { createRequirementPlanPrompt, parseRequirementPlanGenerationOutput } = 
    await import("./requirement-intake.js");
  
  // 生成提示
  const prompt = createRequirementPlanPrompt(requirement);
  
  // 创建临时输入文件用于claude code
  const tempInputPath = resolve(options.tempDir || "/tmp", `plan-prompt-${Date.now()}.txt`);
  writeFileSync(tempInputPath, prompt);
  
  console.log(`\n📝 生成计划提示已保存到: ${tempInputPath}`);
  console.log(`\n🤖 调用Claude Code生成计划...`);
  
  // 调用claude code（通过shell命令）
  let output;
  try {
    // 这里使用 claude code 命令，实际调用取决于 claude code 的安装方式
    // 当前仅作示例，实际需要根据 claude code 的真实API调整
    output = execSync(`cat ${tempInputPath} | claude code generate-plan`, {
      encoding: "utf-8",
      timeout: 300000 // 5分钟超时
    });
  } catch (error) {
    console.error("❌ Claude Code 调用失败");
    throw error;
  }
  
  // 解析输出
  const parsed = parseRequirementPlanGenerationOutput(requirement, output);
  
  if (parsed.status !== "pass") {
    console.error("❌ 计划生成失败:", parsed.issues);
    throw new Error(`Plan generation failed: ${parsed.issues.join(", ")}`);
  }
  
  console.log("✅ 计划生成成功");
  return parsed;
}

/**
 * 模拟计划生成（用于测试）
 */
export function generatePlanMock(requirement = {}) {
  // 这是一个占位符，用于测试流程而不实际调用LLM
  return {
    status: "pass",
    plan: {
      steps: [
        { id: "step-1", title: "现状盘点", description: "枚举前端入口和资源" },
        { id: "step-2", title: "Next.js骨架", description: "建立项目框架" },
        { id: "step-3", title: "约束文档", description: "沉淀使用规范" },
        { id: "step-4", title: "视图迁移", description: "切片迁移核心视图" },
        { id: "step-5", title: "数据层对接", description: "统一API客户端" },
        { id: "step-6", title: "清理下线", description: "移除原生入口" },
        { id: "step-7", title: "发布验证", description: "真实环境验证" }
      ]
    }
  };
}
