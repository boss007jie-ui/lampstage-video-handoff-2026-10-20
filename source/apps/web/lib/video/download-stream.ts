/**
 * 有界、可取消的文件下载。
 *
 * 为什么需要它（2026-10-14 生产事故）：
 * 旧实现用 `fs.open()` 拿到 FileHandle，再 `handle.createWriteStream({ autoClose: false })`
 * 配 `pipeline()`。问题是 **pipeline 会正常返回**，卡住的是随后的 `await handle.close()` ——
 * FileHandle-backed 写入流仍持有句柄引用，而 `autoClose: false` 关掉了自动关闭，
 * 于是 close 一直等待该引用释放。串行 worker 的主循环就此停住，
 * 独立的心跳 interval 照常续租，任务表现为 preparing 长时间不变（实测 88 分钟）。
 *
 * 因此这里**禁止**使用 FileHandle + `autoClose: false`：直接让 `createWriteStream(path)`
 * 自己管理句柄（默认自动关闭），并给整条链路加上字节上限、总超时与取消。
 *
 * 写入语义：先写 `<target>.<uuid>.part`，全部校验通过后才 rename 覆盖目标。
 * 失败、超时、取消一律不触碰已有目标文件，并清理临时文件。
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type DownloadInput = {
  target: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * 打开远端流。**必须把 signal 真正传到网络层**（SDK 的 abortSignal / fetch 的 signal），
   * 否则"超时"只是本地的假超时：函数返回了，请求还在后台继续。
   */
  open: (signal: AbortSignal) => Promise<{
    body: Readable;
    expectedBytes?: number;
  }>;
  /**
   * 仅供测试注入写入流（默认 createWriteStream(target, { flags:"wx", mode:0o600 })）。
   * 生产路径不传，行为不变；注入它才能确定性地触发"真实写入阶段"的错误，
   * 从而验证源流被销毁、临时文件被清理、已有目标不被覆盖。
   */
  createWrite?: (target: string) => Writable;
};

/** 下载到目标文件，返回真实落盘字节数。任何失败都不留下半成品。 */
export async function downloadStreamToFile(input: DownloadInput): Promise<number> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("invalid_download_limits");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, input.timeoutMs);
  const temp = `${input.target}.${randomUUID()}.part`;
  let body: Readable | undefined;
  let bytes = 0;
  try {
    controller.signal.throwIfAborted();
    await mkdir(path.dirname(input.target), { recursive: true });
    const opened = await input.open(controller.signal);
    body = opened.body;
    controller.signal.throwIfAborted();
    const expected = opened.expectedBytes;
    if (expected !== undefined &&
        (!Number.isSafeInteger(expected) || expected <= 0 || expected > input.maxBytes)) {
      throw new Error("invalid_download_length");
    }
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(bytes > input.maxBytes ? new Error("download_too_large") : null, chunk);
      },
    });
    await pipeline(body, limit, (input.createWrite ?? (file => createWriteStream(file, { flags: "wx", mode: 0o600 })))(temp),
      { signal: controller.signal });
    // 只有"确实写完且长度自洽"才允许替换目标：空流与长度不符都视为失败。
    if (bytes === 0 || (expected !== undefined && bytes !== expected)) {
      throw new Error("download_length_mismatch");
    }
    controller.signal.throwIfAborted();
    await rename(temp, input.target);
    return bytes;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    body?.destroy();
    await rm(temp, { force: true });
  }
}
