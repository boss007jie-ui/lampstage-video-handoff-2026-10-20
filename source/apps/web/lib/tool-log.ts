/**
 * 外部工具调用日志。
 *
 * 设计原则：fire-and-forget，绝不影响主流程。
 *   - 写库失败只 console.warn，不抛错（日志不能拖垮生图 / 渲染）。
 *
 * 两个来源：
 *   1. 服务端分析链路（识图 / 提示词规划 / 生图 / 分镜质检）—— 直接调 logToolCall。
 *   2. MCP 工具调用（`/api/mcp`，即客户经 WorkBuddy 专家实际走的入口）—— 调 logMcpCall。
 */
import { prisma } from "@/lib/db";

/** MCP 工具调用统一以 `mcp_` 前缀落库，与服务端分析链路区分开。 */
export type McpToolName = `mcp_${string}`;

export type ToolName =
  | "lamp_profile"
  | "prompt_planner"
  | "nano-banana"
  | "gpt-image-2"
  | "scene_quality"
  | McpToolName;

export type ToolLogInput = {
  tool: ToolName;
  model?: string | null;
  jobId?: string | null;
  assetId?: string | null;
  status: "ok" | "failed";
  httpStatus?: number | null;
  durationMs?: number | null;
  error?: string | null;
  resultJson?: string | null;
};

/** 写一条调用日志。永不抛错。 */
export async function logToolCall(input: ToolLogInput): Promise<void> {
  try {
    await prisma.toolCallLog.create({
      data: {
        tool: input.tool,
        model: input.model ?? null,
        job_id: input.jobId ?? null,
        asset_id: input.assetId ?? null,
        status: input.status,
        http_status: input.httpStatus ?? null,
        duration_ms: input.durationMs ?? null,
        error: input.error ? input.error.slice(0, 500) : null,
        result_json: input.resultJson ?? null,
      },
    });
  } catch (e) {
    console.warn("[tool-log] write failed (ignored):", e);
  }
}

export type McpCallLogInput = {
  /** MCP 原始工具名，如 create_video_job；落库时自动加 `mcp_` 前缀。 */
  tool: string;
  status: "ok" | "failed";
  /** 同步方法（initialize / tools/list）没有有意义的耗时，传 undefined 即落 null。 */
  durationMs?: number | null;
  httpStatus?: number | null;
  jobId?: string | null;
  assetId?: string | null;
  error?: string | null;
};

/**
 * 记一次 MCP 工具调用。
 *
 * 为什么需要它：`/api/mcp` 是**客户真实使用的入口**，但它原先一条日志都不写 ——
 * 客户调了什么、成没成、耗时多久，服务端完全读不到，只能靠客户端日志反推
 * （而客户端日志也只有授权诊断）。没有这条记录，"功能跑通"就没有可核对的判据。
 *
 * 刻意同步返回 void：调用点不需要 await，杜绝"日志失败拖慢工具返回"。
 */
export function logMcpCall(input: McpCallLogInput): void {
  void logToolCall({
    tool: `mcp_${input.tool}` as ToolName,
    model: null,
    jobId: input.jobId ?? null,
    assetId: input.assetId ?? null,
    status: input.status,
    httpStatus: input.httpStatus ?? null,
    durationMs: input.durationMs ?? null,
    error: input.error ?? null,
    resultJson: null,
  });
}
