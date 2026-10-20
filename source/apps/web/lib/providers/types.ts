/**
 * Generation provider abstraction.
 *
 * 多家图像生成 API 都长得不一样（Gemini contents/parts、OpenAI images、
 * Replicate predictions、字节/通义/即梦各自 SDK），所以业务层只对这个抽象
 * 编程，换 provider 只换文件不动业务。
 */

export type AspectRatio = "1_1" | "4_5" | "16_9" | "9_16";
export type PlatformStyle = "domestic_ecommerce" | "brand_site";

export type Stage =
  | "analyzing"
  | "matching"
  | "generating"
  | "lighting"
  | "finalizing";

export interface GenInput {
  /** 拼好的最终 prompt（含模板、平台风格、负面约束） */
  prompt: string;
  /** 用户上传的灯具参考图 URL（公网可访问） */
  referenceImageUrl: string;
  /** 可选：场景/房间构图参考图 URL。用于多图参考，让模型保持房间布局和尺度。 */
  compositionReferenceUrl?: string;
  /** Private video frames can be supplied without publishing their storage URLs. */
  referenceImageData?: { bytes: Buffer; mime: string };
  compositionReferenceData?: { bytes: Buffer; mime: string };
  /** Ordered, pinned image bytes. When supplied, legacy composition fields must be absent. */
  referenceImages?: Array<{ bytes: Buffer; mime: string }>;
  requestTimeoutMs?: number;
  /** 显式请求原生2K；只由支持该选项的模型接受，不能用放大代替。 */
  imageSize?: "2K";
  aspectRatio: AspectRatio;
  platformStyle: PlatformStyle;
  /** MVP 固定 4 */
  outputCount: number;
  /** 可选：关联的生成任务 id，仅用于调用日志（ToolCallLog） */
  jobId?: string;
  /**
   * 可选：父级取消信号（视频任务 STOP 时用）。
   * 不传时行为与以前完全一致——图片通道不受影响。
   */
  signal?: AbortSignal;
  /**
   * 可选：**真实 HTTP POST 之前**的最后一道闸门，在参考图异步预处理完成之后执行。
   * 仅视频链路会传；不传时图片通道行为不变。
   */
  beforeSend?: () => Promise<void>;
}

/** 单次调用结果：要么拿到 1 张图，要么失败。 */
export interface GenSingleResult {
  ok: boolean;
  /** PNG/JPEG 二进制 */
  bytes?: Buffer;
  mime?: string;
  /** 失败原因（人类可读，发给前端展示） */
  error?: string;
  /** Only the provider's reported token counts; absent when none were reported. */
  usage?: ProviderReportedUsage;
  /** What is known about submission to the provider, independent of image delivery. */
  attempt?: ProviderAttempt;
}

export interface ProviderAttempt {
  status: "not_submitted" | "response_received" | "unknown";
  http_status: number | null;
  /** 固定分类，绝不携带供应商正文、消息或请求地址。 */
  error_category?: import("./image-diagnostics").ImageErrorCategory;
}

export interface ProviderReportedUsage {
  source: "provider_reported";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
}

export interface IGenerationProvider {
  /** Provider 名字（写进任务记录方便排查） */
  readonly name: string;

  /** 单次调用，输出 1 张图。整体的"4 张"由编排层并发跑 4 次 submit 组装。 */
  generate(input: GenInput): Promise<GenSingleResult>;
}
