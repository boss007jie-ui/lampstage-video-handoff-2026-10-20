import { ImageJobError } from "./image-contracts";

/** 服务端注入，不读取环境配置；实现必须按 key 原子不可覆盖，不允许把 key 当任意 URL fetch。 */
export interface ImmutableImageStore {
  read(key: string, maxBytes: number): Promise<Buffer>;
  /** 已存在相同 bytes/MIME 为幂等成功；不同内容必须冲突。返回前对象须完整可读。 */
  putIfAbsent(key: string, bytes: Buffer, mime: string): Promise<void>;
}
export interface ImageStorageConfig { publicBase?: string }
function publicBase(config: ImageStorageConfig): string {
  if (!config.publicBase) return "";
  const value = config.publicBase.replace(/\/+$/, ""), url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      value.includes("%") || value.includes("\\")) throw new ImageJobError("bad_image_storage_config");
  return value;
}
function assertKey(key: string): void {
  if (!/^[A-Za-z0-9_./-]+$/.test(key) || key.startsWith("/") || key.split("/").some(p => !p || p === "." || p === ".."))
    throw new ImageJobError("unsafe_image_storage_key");
}
export function originalImageKey(userId: string, location: string, config: ImageStorageConfig): string {
  const base = publicBase(config);
  const key = location.startsWith("/") ? location.slice(1) : base && location.startsWith(`${base}/`) ? location.slice(base.length + 1) : "";
  assertKey(key);
  if (!/^[A-Za-z0-9_.-]+$/.test(userId) || !key.startsWith(`uploads/${userId}/`)) throw new ImageJobError("image_reference_location_invalid");
  return key;
}
export function generatedImageKey(artifactId: string, mime: string): string {
  if (!/^image-[a-f0-9]{64}$/.test(artifactId) || !["image/png", "image/jpeg", "image/webp"].includes(mime))
    throw new ImageJobError("bad_image_artifact");
  return `generated/agent-images/${artifactId}.${mime.slice(6)}`;
}
export function generatedImageLocation(key: string, config: ImageStorageConfig): string {
  if (!/^generated\/agent-images\/image-[a-f0-9]{64}\.(png|jpeg|webp)$/.test(key)) throw new ImageJobError("unsafe_image_storage_key");
  return `${publicBase(config)}/${key}`;
}
