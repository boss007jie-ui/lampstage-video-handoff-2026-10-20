/** S3-compatible settings shared by public image storage and private video storage.
 *
 * R2 historically needed path-style addressing in this project. Tencent COS and
 * Alibaba OSS use virtual-hosted addressing for new buckets, so the provider
 * deployment sets the corresponding *_FORCE_PATH_STYLE flag explicitly.
 */
export function s3Region(scope: "public" | "video"): string {
  const scoped = scope === "video" ? process.env.VIDEO_R2_REGION : process.env.R2_REGION;
  return scoped || process.env.S3_REGION || "auto";
}

export function s3ForcePathStyle(scope: "public" | "video"): boolean {
  const scoped = scope === "video" ? process.env.VIDEO_R2_FORCE_PATH_STYLE : process.env.R2_FORCE_PATH_STYLE;
  if (scoped !== undefined) return scoped.trim().toLowerCase() === "true";
  const endpoint = scope === "video" ? process.env.R2_ENDPOINT : process.env.R2_ENDPOINT;
  // Preserve the existing Cloudflare R2 behavior when upgrading an old deployment.
  return Boolean(endpoint && /r2\.cloudflarestorage\.com$/i.test(endpoint));
}
