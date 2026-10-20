import { nanoBananaProvider } from "@/lib/providers/nano-banana";
import { assertVideoPaidGenerationEnabled } from "./control";
import { VideoPipelineError } from "./media";
import sharp from "sharp";

/** Roles follow Hypit image-direction: frame supplies composition, product supplies physical facts. */
export async function generateReference(input: {
  product: { bytes: Buffer; mime: string };
  frame: Buffer;
  endpoint: "opening" | "ending";
  instructions: string;
  jobId: string;
  /** 父级取消信号（视频任务停止时），会穿透到 HTTP 请求与结果下载。 */
  signal?: AbortSignal;
  /** 仅供测试注入环境；默认读进程环境。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 真正发出 HTTP POST 之前的复核（租约/revision/consent）。
   * 注意：**付费开关不依赖这个回调**——下面自身就会强制检查。
   */
  beforeSubmit?: () => Promise<void>;
}): Promise<{ bytes: Buffer; mime: string }> {
  // 自身强制检查视频付费开关：不能靠调用方传入可选回调才生效。
  // 普通图片业务走的是别的入口，不受这里影响。
  assertVideoPaidGenerationEnabled(input.env ?? process.env);
  input.signal?.throwIfAborted();
  const result = await nanoBananaProvider.generate({
    referenceImageUrl: "", referenceImageData: input.product,
    compositionReferenceData: { bytes: input.frame, mime: "image/png" },
    // Native new-model output is square; the existing video-frame crop below produces 720×1280.
    aspectRatio: "1_1", platformStyle: "brand_site", outputCount: 1, jobId: input.jobId, requestTimeoutMs: 120_000,
    signal: input.signal,
    // 这道闸门由 provider 在**完成参考图预处理之后、发出 HTTP POST 之前**调用。
    beforeSend: async () => {
      assertVideoPaidGenerationEnabled(input.env ?? process.env);
      input.signal?.throwIfAborted();
      await input.beforeSubmit?.();
    },
    prompt: `Create a photorealistic ${input.endpoint === "opening" ? "opening" : "ending"} frame for a product video. Image 1 is the exact source-video frame: preserve its setting, architecture, furnishings, people, action state, framing, camera angle and natural exposure. Image 2 is the product: reproduce its exact silhouette, component count, geometry, proportions, material, finish and color. Replace only the subject identified by the user with this product. Keep a plausible scale, support, gravity, occlusion, contact and cast shadows appropriate to this product category. Use only the supports or mounting mechanisms visible in the supplied product. Preserve all unrelated objects. Match the source frame's photographic texture and lighting. This ${input.endpoint} frame follows its own supplied source moment, preserving the distinct camera/action position visible there. No collage, diagram, duplicate product, added text or watermark. User direction: ${input.instructions || "Keep the source setting and showcase the supplied product naturally."}`,
  });
  if (!result.ok || !result.bytes || !result.mime?.startsWith("image/")) throw new VideoPipelineError("参考图生成未完成；已记录调用次数，请人工核对后再继续。");
  const bytes = await sharp(result.bytes).rotate().resize(720, 1280, { fit: "cover" }).png().toBuffer();
  return { bytes, mime: "image/png" };
}

export function videoDirection(instructions: string): string {
  return `Recreate the supplied reference clip's complete camera movement, action timing, physical interactions and scene continuity. The product image establishes the product's exact shape, component count, proportions, material and color. The opening and ending images anchor the scene's respective start and end states. Carry the same product continuously between them at a physically plausible scale and location with stable support, perspective, occlusion and lighting appropriate to its category. Preserve the reference environment, furniture, people and their actions. Keep product identity consistent through camera motion: no shape drift, duplicated products, unsupported floating objects or added text. Follow the source clip's existing cuts and motion; do not invent a new scene or camera path. ${instructions || "Show the product naturally within the reference action."}`;
}
