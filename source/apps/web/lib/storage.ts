/**
 * 对象存储 adapter — 两路：本地 fs / Cloudflare R2。
 *
 * 自动检测：env 里有 R2_ACCESS_KEY_ID 就走 R2，否则写本地 public/ 目录（开发用）。
 * 这样本地 dev 不需要联网，CI / 部署到 Pages 就自动切到 R2。
 *
 * 上传到 R2 后返回的 URL 是 R2_PUBLIC_BASE + path（用 r2.dev 公开域名 / 或自定义域名）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { s3ForcePathStyle, s3Region } from "./s3-config";

const SUBDIR_GENERATED = "generated";
const SUBDIR_UPLOADS = "uploads";
const SUBDIR_SUGGEST = "suggest-thumbs";

function isR2(): boolean {
  return Boolean(
    process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET &&
      process.env.R2_ENDPOINT,
  );
}

let r2Client: S3Client | null = null;
function getR2(): S3Client {
  if (r2Client) return r2Client;
  r2Client = new S3Client({
    region: s3Region("public"),
    endpoint: process.env.R2_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: s3ForcePathStyle("public"),
  });
  return r2Client;
}

function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

function publicBase(): string {
  return process.env.R2_PUBLIC_BASE?.replace(/\/$/, "") || "";
}

/**
 * 写一个对象。key 形如 "generated/<job>/<n>" 或 "uploads/<user>/<id>"。
 * 返回浏览器可访问的 URL。
 */
export async function putObject(
  key: string,
  data: Buffer,
  mime: string = "image/jpeg",
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const ext = extFromMime(mime);
  const finalKey = key.endsWith(`.${ext}`) ? key : `${key}.${ext}`;

  if (isR2()) {
    const cmd = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: finalKey,
      Body: data,
      ContentType: mime,
      // 让浏览器和 CDN 长缓存（生成图本就是不变的）
      CacheControl: "public, max-age=31536000, immutable",
    });
    await getR2().send(cmd, { abortSignal: options.signal });
    const base = publicBase();
    if (base) {
      return `${base}/${finalKey}`;
    }
    // fallback: just return the key, callers must resolve themselves
    return `/${finalKey}`;
  }

  // local fs (dev)
  const fullPath = path.join(process.cwd(), "public", finalKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, data, { signal: options.signal });
  return `/${finalKey.replace(/\\/g, "/")}`;
}

/**
 * 兼容老路径：把"裸 key"（不带 generated/ 前缀）自动放进 generated/ 下。
 * 旧代码大量调用 putObject("<jobId>/0", data) 期望落到 /generated/<jobId>/0.jpg。
 */
export async function putGeneratedImage(
  relKey: string,
  data: Buffer,
  mime: string = "image/jpeg",
): Promise<string> {
  return putObject(`${SUBDIR_GENERATED}/${relKey}`, data, mime);
}

export async function putUploadedAsset(
  relKey: string,
  data: Buffer,
  mime: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  return putObject(`${SUBDIR_UPLOADS}/${relKey}`, data, mime, options);
}

export async function putSuggestThumb(
  relKey: string,
  data: Buffer,
  mime: string = "image/jpeg",
): Promise<string> {
  return putObject(`${SUBDIR_SUGGEST}/${relKey}`, data, mime);
}

export async function deleteObject(urlOrKey: string): Promise<void> {
  // 把 URL 还原成 key
  let key = urlOrKey;
  const base = publicBase();
  if (base && key.startsWith(base + "/")) {
    key = key.slice(base.length + 1);
  } else if (key.startsWith("/")) {
    key = key.slice(1);
  }

  if (isR2()) {
    try {
      await getR2().send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET!,
          Key: key,
        }),
      );
    } catch {
      // 不存在就算了
    }
    return;
  }

  const fullPath = path.join(process.cwd(), "public", key);
  try {
    await fs.unlink(fullPath);
  } catch {
    /* gone */
  }
}

/**
 * 读对象成 Buffer。给 nano banana provider 把"我们刚上传的图"作参考图用。
 *
 * 接受：完整 R2 公开 URL / 本地相对路径 (/uploads/abc.jpg) / 或 raw key。
 * 返回 { bytes, mime }。
 */
export async function getObjectBytes(
  urlOrKey: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ bytes: Buffer; mime: string }> {
  // 不传 signal/timeoutMs/maxBytes 时行为与以前完全一致（图片通道不受影响）。
  const signal = options.signal
    ? (options.timeoutMs ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : options.signal)
    : (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined);
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) throw new Error("invalid_max_bytes");
  /** 累积读取时按**实际字节**设限：Content-Length 是声明值，不能当安全边界。 */
  const collect = async (chunks: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): Promise<Buffer> => {
    const parts: Buffer[] = [];
    let total = 0;
    for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (maxBytes !== undefined && total > maxBytes) throw new Error("object_too_large");
      parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts);
  };
  // 还原成 key
  let key = urlOrKey;
  const base = publicBase();
  if (base && key.startsWith(base + "/")) {
    key = key.slice(base.length + 1);
  } else if (key.startsWith("http://") || key.startsWith("https://")) {
    // 远程 URL 但不是我们的 R2 公开域名：直接 fetch
    const r = await fetch(key, { signal });
    if (!r.ok) {
      throw new Error(`fetch ${key} failed: ${r.status}`);
    }
    if (!r.body) throw new Error("empty_response_body");
    return {
      bytes: await collect(r.body),
      mime: r.headers.get("content-type") || "image/jpeg",
    };
  } else if (key.startsWith("/")) {
    key = key.slice(1);
  }

  if (isR2()) {
    const obj = await getR2().send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: key,
      }),
      { abortSignal: signal },
    );
    if (!obj.Body) throw new Error("Media not found");
    return {
      bytes: await collect(obj.Body as unknown as AsyncIterable<Uint8Array>),
      mime: obj.ContentType ?? "image/jpeg",
    };
  }

  // local fs
  const fullPath = path.join(process.cwd(), "public", key);
  if (maxBytes !== undefined) {
    const { size } = await fs.stat(fullPath);
    if (size > maxBytes) throw new Error("object_too_large");
  }
  const buf = await fs.readFile(fullPath);
  if (maxBytes !== undefined && buf.byteLength > maxBytes) throw new Error("object_too_large");
  const ext = path.extname(fullPath).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : "image/jpeg";
  return { bytes: buf, mime };
}
