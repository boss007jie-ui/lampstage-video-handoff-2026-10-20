import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { probeMedia } from "../../lib/video/media";
import { candidateIdentityDigest, candidateKey, createCandidateCollector, type CandidateCollectorDependencies,
  type CollectorIdentity, type StoredCandidate, type CandidateStorage } from "../../lib/video/backend-runtime/collector";

const execute = promisify(execFile);
const identity: CollectorIdentity = { userId: "user-1", jobId: "job-1", segmentIndex: 0, attempt: 1,
  inputDigest: "f".repeat(64), requestedDuration: 2, width: 64, height: 64 };
const signedUrl = "https://video.example.test/private?signature=should-never-appear";

class MemoryStorage implements CandidateStorage {
  readonly objects = new Map<string, StoredCandidate>();
  losePutResponse = false;
  failRead = false;
  async putIfAbsent(key: string, object: StoredCandidate): Promise<"created" | "exists"> {
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, { bytes: Buffer.from(object.bytes), receipt: { ...object.receipt } });
    if (this.losePutResponse) throw new Error("simulated response loss");
    return "created";
  }
  async read(key: string): Promise<StoredCandidate | null> {
    if (this.failRead) throw new Error("storage unavailable");
    return this.objects.get(key) ?? null;
  }
}

function fixtureDeps(bytes: Uint8Array, workspace: string) {
  const storage = new MemoryStorage();
  let status = 200;
  let addresses = ["203.0.113.7"];
  let requests = 0;
  let probeIndex = 0;
  const deps: CandidateCollectorDependencies = {
    storage,
    transport: {
      async resolveAddresses() { return addresses; },
      async request({ connectAddress, signal }) {
        requests++;
        assert.equal(connectAddress, "203.0.113.7");
        assert.equal(signal.aborted, false);
        return { status, body: (async function* () { yield bytes.subarray(0, 7); yield bytes.subarray(7); })() };
      },
    },
    media: { async inspect(contents) {
      const file = path.join(workspace, `probe-${++probeIndex}.mp4`);
      await writeFile(file, contents);
      return probeMedia(file);
    } },
    policy: { allowedHosts: ["video.example.test"], allowAddress: address => address === "203.0.113.7",
      maxBytes: 1024 * 1024, timeoutMs: 10_000, durationToleranceSeconds: 0.15 },
  };
  return { deps, storage, setStatus(value: number) { status = value; }, setAddresses(value: string[]) { addresses = value; }, get requests() { return requests; } };
}

test("collector checks real video, SHA256, stable key and durable readback", async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), "lamp-candidate-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const valid = path.join(workspace, "valid.mp4");
  await execute(process.env.VIDEO_FFMPEG_PATH || "ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=2",
    "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", valid], { windowsHide: true });
  const bytes = await readFile(valid);
  const setup = fixtureDeps(bytes, workspace);
  const collector = createCandidateCollector(setup.deps);
  const receipt = await collector.collect(identity, signedUrl);
  assert.deepEqual(receipt, { key: candidateKey(identity), sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length, duration: 2, width: 64, height: 64, identityDigest: candidateIdentityDigest(identity) });
  assert.deepEqual(await collector.recover(identity), receipt);
  assert.equal(setup.requests, 1);
  const mismatched = fixtureDeps(bytes, workspace);
  await assert.rejects(createCandidateCollector(mismatched.deps).collect({ ...identity, requestedDuration: 4 }, signedUrl), { code: "collector_media_invalid" });
  await assert.rejects(createCandidateCollector(mismatched.deps).collect({ ...identity, width: 128 }, signedUrl), { code: "collector_media_invalid" });

  await t.test("expired link recovers stored candidate without submitting or rewriting", async () => {
    setup.setStatus(403);
    assert.deepEqual(await collector.collect(identity, signedUrl), receipt);
    assert.equal(setup.storage.objects.size, 1);
  });
  await t.test("different valid bytes at same key are a conflict", async () => {
    const other = path.join(workspace, "other.mp4");
    await execute(process.env.VIDEO_FFMPEG_PATH || "ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=2",
      "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", other], { windowsHide: true });
    const second = fixtureDeps(await readFile(other), workspace);
    second.deps.storage = setup.storage;
    await assert.rejects(createCandidateCollector(second.deps).collect(identity, signedUrl), { code: "collector_storage_conflict" });
  });
  await t.test("cross-user and tampered receipts cannot be recovered", async () => {
    assert.equal(await collector.recover({ ...identity, userId: "other" }), null);
    const object = setup.storage.objects.get(receipt.key)!;
    object.receipt.identityDigest = candidateIdentityDigest({ ...identity, userId: "other" });
    await assert.rejects(collector.recover(identity), { code: "collector_receipt_invalid" });
    object.receipt.identityDigest = receipt.identityDigest;
    object.bytes = Buffer.concat([object.bytes, Buffer.from("altered")]);
    await assert.rejects(collector.recover(identity), { code: "collector_receipt_invalid" });
  });
});

test("collector rejects unsafe download and damaged media with safe errors", async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), "lamp-candidate-bad-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const setup = fixtureDeps(Buffer.from("not a video"), workspace);
  const collector = createCandidateCollector(setup.deps);
  for (const url of ["http://video.example.test/a", "https://other.test/a", "https://u:p@video.example.test/a", "https://video.example.test:8443/a"]) {
    await assert.rejects(collector.collect(identity, url), { code: "collector_url_rejected" });
  }
  assert.equal(setup.requests, 0);
  setup.setAddresses(["203.0.113.7", "127.0.0.1"]);
  await assert.rejects(collector.collect(identity, signedUrl), { code: "collector_dns_rejected" });
  assert.equal(setup.requests, 0);
  setup.setAddresses(["203.0.113.7"]);
  setup.setStatus(302);
  await assert.rejects(collector.collect(identity, signedUrl), { code: "collector_download_failed" });
  setup.setStatus(200);
  await assert.rejects(collector.collect(identity, signedUrl), { code: "collector_media_invalid" });
  assert.equal(setup.storage.objects.size, 0);
  setup.deps.policy.maxBytes = 5;
  await assert.rejects(createCandidateCollector(setup.deps).collect(identity, signedUrl), { code: "collector_download_too_large" });
});

test("download deadline aborts a stalled request without exposing its URL", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "lamp-candidate-timeout-"));
  try {
    const setup = fixtureDeps(Buffer.from("unused"), workspace);
    let aborted = false;
    setup.deps.policy.timeoutMs = 20;
    setup.deps.transport.request = async ({ signal }) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise<never>(() => {});
    };
    await assert.rejects(createCandidateCollector(setup.deps).collect(identity, signedUrl), error => {
      assert.equal((error as { code?: string }).code, "collector_download_timeout");
      assert.equal(String(error).includes("should-never-appear"), false);
      return true;
    });
    assert.equal(aborted, true);
    assert.equal(setup.storage.objects.size, 0);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("lost put response is recovered by readback; missing readback never publishes receipt", async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), "lamp-candidate-loss-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const valid = path.join(workspace, "valid.mp4");
  await execute(process.env.VIDEO_FFMPEG_PATH || "ffmpeg", ["-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=64x64:r=10:d=2",
    "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", valid], { windowsHide: true });
  const setup = fixtureDeps(await readFile(valid), workspace);
  const beforeWrite = fixtureDeps(await readFile(valid), workspace);
  beforeWrite.deps.storage.putIfAbsent = async () => { throw new Error("before-write-failure"); };
  await assert.rejects(createCandidateCollector(beforeWrite.deps).collect(identity, signedUrl), { code: "collector_storage_failed" });
  assert.equal(beforeWrite.storage.objects.size, 0);
  const partial = fixtureDeps(await readFile(valid), workspace);
  partial.deps.storage.putIfAbsent = async (key, object) => {
    partial.storage.objects.set(key, { bytes: object.bytes.slice(0, 20), receipt: object.receipt });
    throw new Error("partial-storage-failure");
  };
  await assert.rejects(createCandidateCollector(partial.deps).collect(identity, signedUrl), { code: "collector_receipt_invalid" });
  setup.storage.losePutResponse = true;
  const collector = createCandidateCollector(setup.deps);
  const receipt = await collector.collect(identity, signedUrl);
  assert.deepEqual(await collector.recover(identity), receipt);
  setup.storage.failRead = true;
  await assert.rejects(collector.collect({ ...identity, segmentIndex: 1 }, signedUrl), { code: "collector_storage_failed" });
});

test("collector tolerance stays within the shared 0.5 second receipt boundary", async () => {
  const bytes = Buffer.from("fake-media-port-fixture");
  const make = (durationToleranceSeconds: number, duration: number) => {
    const storage = new MemoryStorage();
    const deps: CandidateCollectorDependencies = { storage,
      media: { inspect: async () => ({ duration, width: 64, height: 64 }) },
      transport: { resolveAddresses: async () => ["203.0.113.7"], request: async () => ({ status: 200, body: (async function* () { yield bytes; })() }) },
      policy: { allowedHosts: ["video.example.test"], allowAddress: address => address === "203.0.113.7", maxBytes: 1024, timeoutMs: 1000, durationToleranceSeconds } };
    return { deps, storage };
  };
  for (const tolerance of [-0.001, 0.500001, 1, Infinity, NaN]) assert.throws(() => createCandidateCollector(make(tolerance, 2).deps));
  for (const [tolerance, duration] of [[0, 2], [0.5, 1.5], [0.5, 2.5]]) {
    const setup = make(tolerance, duration);
    assert.equal((await createCandidateCollector(setup.deps).collect(identity, signedUrl)).duration, duration);
  }
  const outside = make(0.5, 2.500001);
  await assert.rejects(createCandidateCollector(outside.deps).collect(identity, signedUrl), { code: "collector_media_invalid" });
  assert.equal(outside.storage.objects.size, 0);
});
