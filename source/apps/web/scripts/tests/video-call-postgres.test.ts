import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { closeSync, openSync } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { callIdentity, inputDigest, parseCallInput, type SingleCall } from "../../lib/video-calls/contract";

const require = createRequire(import.meta.url);
const enabled = process.env.RUN_VIDEO_CALL_DATABASE_TESTS === "1" && process.platform === "win32";

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const ddl = [
  `CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN')`,
  `CREATE TYPE "CreditTxType" AS ENUM ('grant', 'consume', 'refund', 'manual_adjustment')`,
  `CREATE TABLE "User" (
    "id" TEXT PRIMARY KEY, "name" TEXT, "email" TEXT UNIQUE, "phone" TEXT UNIQUE,
    "password_hash" TEXT, "email_verified" TIMESTAMP(3), "credit_balance" INTEGER NOT NULL DEFAULT 0,
    "credits_unlimited" BOOLEAN NOT NULL DEFAULT false, "role" "Role" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE "VideoAsset" (
    "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
    "storage_key" TEXT NOT NULL UNIQUE, "mime" TEXT NOT NULL, "size_bytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending', "sha256" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  // Only the FK target key is needed; this test never creates a GenerationJob.
  `CREATE TABLE "GenerationJob" ("id" TEXT PRIMARY KEY)`,
  `CREATE TABLE "VideoJob" (
    "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
    "source_asset_id" TEXT NOT NULL REFERENCES "VideoAsset"("id"), "template_version_id" TEXT, "product_asset_id" TEXT NOT NULL,
    "title" TEXT NOT NULL, "instructions" TEXT NOT NULL DEFAULT '', "preserve_audio" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'draft', "phase" TEXT NOT NULL DEFAULT 'prepare', "stage" TEXT NOT NULL DEFAULT 'waiting',
    "data" JSONB NOT NULL, "error" TEXT, "lease_owner" TEXT, "lease_until" TIMESTAMP(3), "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE "CreditTransaction" (
    "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
    "type" "CreditTxType" NOT NULL, "amount" INTEGER NOT NULL, "related_job_id" TEXT REFERENCES "GenerationJob"("id"),
    "note" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX "VideoJob_user_id_created_at_idx" ON "VideoJob"("user_id", "created_at")`,
  `CREATE INDEX "VideoJob_status_created_at_idx" ON "VideoJob"("status", "created_at")`,
  `CREATE INDEX "CreditTransaction_user_id_created_at_idx" ON "CreditTransaction"("user_id", "created_at")`,
];

test("single-call acceptance and ledger use real isolated PostgreSQL transactions", { skip: !enabled, timeout: 180_000 }, async t => {
  // Never read, preserve, or use a developer DATABASE_URL. The module's unused
  // default client is explicitly disabled; all operations receive isolated clients.
  process.env.DATABASE_URL = "postgresql://disabled@127.0.0.1:1/disabled";
  const { acceptVideoCall, callView } = await import("../../lib/video-calls/service");
  const { refundVideoCallCredits, consumeVideoCallCredits, InsufficientCreditsError } = await import("../../lib/credits");
  const tempRoot = path.resolve("C:/Users/boss0/AppData/Local/Temp");
  const workspace = path.join(tempRoot, `lampstage-video-call-pg-20261018-${randomUUID()}`);
  assert.equal(path.dirname(path.resolve(workspace)), tempRoot);
  await mkdir(workspace); // No recursive flag: refuse an existing directory.
  const artifacts = path.resolve(process.cwd(), "../../.codex-tmp/workbuddy-local-trial-20261018");
  await mkdir(artifacts, { recursive: true });
  const native = path.join(workspace, "native");
  const data = path.join(workspace, "data");
  const passwordFile = path.join(workspace, "password.tmp");
  const nativeSource = path.resolve(path.dirname(require.resolve("@embedded-postgres/windows-x64")), "..", "native");
  await access(path.join(nativeSource, "bin", "postgres.exe"));
  const port = await freeLoopbackPort();
  const password = randomBytes(24).toString("hex");
  const user = "video_call_trial";
  const database = "video_call_trial";
  const url = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?schema=public&connection_limit=2`;
  const report: Record<string, unknown> = { workspace, host: "127.0.0.1", port, database, started: false, stopped: false, credentials_logged: false, checks: [] };
  const command = async (name: string, args: string[]) => {
    const log = openSync(path.join(workspace, "native-commands.log"), "a");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(path.join(native, "bin", `${name}.exe`), args, {
          cwd: workspace, windowsHide: true, stdio: ["ignore", log, log],
          // initdb invokes the Windows command processor while locating postgres.
          // Supply only known public system paths, never inherited user settings.
          env: { NODE_ENV: "test", SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: `${path.join(native, "bin")};C:\\Windows\\System32`,
            COMSPEC: "C:\\Windows\\System32\\cmd.exe", SYSTEMDRIVE: "C:", USERPROFILE: "C:\\Users\\boss0",
            APPDATA: "C:\\Users\\boss0\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\boss0\\AppData\\Local", TEMP: workspace, TMP: workspace },
        });
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)); }, 60_000);
        child.once("error", () => { clearTimeout(timeout); reject(new Error(`${name} could not start`)); });
        child.once("close", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${name} exit ${code}`)); });
      });
    } finally { closeSync(log); }
  };
  const clients: PrismaClient[] = [];
  const client = (connection = url) => { const db = new PrismaClient({ datasourceUrl: connection, log: [] }); clients.push(db); return db; };
  let startAttempted = false;
  try {
    await cp(nativeSource, native, { recursive: true });
    await writeFile(passwordFile, password, { mode: 0o600, flag: "wx" });
    await command("initdb", ["-D", data, "-U", user, "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C"]);
    await rm(passwordFile);
    startAttempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(workspace, "postgres.log"), "-o", `-p ${port} -h 127.0.0.1`, "start", "-w", "-t", "30"]);
    report.started = true;
    report.started_at = new Date().toISOString();
    report.pid = Number((await readFile(path.join(data, "postmaster.pid"), "utf8")).split(/\r?\n/)[0]);
    const admin = client(`postgresql://${user}:${password}@127.0.0.1:${port}/postgres?schema=public`);
    await admin.$executeRawUnsafe(`CREATE DATABASE ${database}`);
    const db = client();
    for (const statement of ddl) await db.$executeRawUnsafe(statement);
    await writeFile(path.join(artifacts, "video-call-postgres-fixture.sql"), ddl.join(";\n\n") + ";\n");
    const peers = Array.from({ length: 8 }, () => client());
    const options = { maxWait: 15_000, timeout: 15_000 };
    const seed = async (id: string, balance: number, unlimited = false) => {
      await db.user.create({ data: { id, credit_balance: balance, credits_unlimited: unlimited } });
      await db.videoAsset.create({ data: { id: `motion-${id}`, user_id: id, storage_key: `test/${id}`, mime: "video/mp4", size_bytes: 100, status: "ready" } });
    };
    const call = (id: string, request = "request", prompt = "isolated trial"): SingleCall => {
      const input = parseCallInput({ request_id: request, motion_asset_id: `motion-${id}`, reference_assets: [{ asset_id: "image-test" }], prompt, duration: 4, max_credits: 20 });
      return { version: 1, kind: "single_call", request_id: request, input_digest: inputDigest(input), input,
        motion: { asset_id: input.motion_asset_id, key: "test/motion.mp4", sha256: "a".repeat(64), size_bytes: 100, mime: "video/mp4" },
        references: [{ asset_id: "image-test", key: "test/image.png", sha256: "b".repeat(64), size_bytes: 100, mime: "image/png" }],
        quote_credits: 12, max_credits: 20, billing: { mode: "standard", charged_credits: 0, refunded_credits: 0 } };
    };
    const balance = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).credit_balance;
    const counts = async (id: string) => ({ jobs: await db.videoJob.count({ where: { user_id: id } }), ledger: await db.creditTransaction.count({ where: { user_id: id } }) });
    const check = async (name: string, run: () => Promise<void>) => t.test(name, async () => { await run(); (report.checks as string[]).push(name); });

    await check("eight simultaneous identical acceptances create one job and one debit", async () => {
      const id = "same-key"; await seed(id, 100);
      const results = await Promise.all(peers.map(peer => peer.$transaction(tx => acceptVideoCall(tx, id, callIdentity(id, "request"), call(id)), options)));
      assert.equal(results.filter(r => !r.reused).length, 1);
      assert.equal(new Set(results.map(r => r.job.id)).size, 1);
      assert.equal(await balance(id), 88);
      assert.deepEqual(await counts(id), { jobs: 1, ledger: 1 });
      const rows = await db.creditTransaction.findMany({ where: { user_id: id } });
      assert.equal(rows[0].amount, -12); assert.equal(rows[0].related_job_id, null);
    });
    await check("different inputs racing on the same request produce one conflict and one debit", async () => {
      const id = "conflict"; await seed(id, 30);
      const results = await Promise.allSettled(peers.slice(0, 2).map((peer, index) => peer.$transaction(tx => acceptVideoCall(tx, id, callIdentity(id, "request"), call(id, "request", `prompt-${index}`)), options)));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
      assert.equal(rejected.reason.code, "request_id_conflict");
      assert.equal(await balance(id), 18); assert.deepEqual(await counts(id), { jobs: 1, ledger: 1 });
    });
    await check("insufficient credits leave neither job nor ledger row", async () => {
      const id = "insufficient"; await seed(id, 11);
      await assert.rejects(db.$transaction(tx => acceptVideoCall(tx, id, callIdentity(id, "request"), call(id)), options), InsufficientCreditsError);
      assert.equal(await balance(id), 11); assert.deepEqual(await counts(id), { jobs: 0, ledger: 0 });
    });
    await check("job FK failure after debit rolls back the actual debit and ledger", async () => {
      const id = "job-rollback"; await seed(id, 30);
      const invalid = call(id); invalid.motion.asset_id = "missing-motion";
      await assert.rejects(db.$transaction(tx => acceptVideoCall(tx, id, callIdentity(id, "request"), invalid), options), (error: any) => error.code === "P2003");
      assert.equal(await balance(id), 30); assert.deepEqual(await counts(id), { jobs: 0, ledger: 0 });
    });
    await check("concurrent refunds restore only the real debit once", async () => {
      const id = "refund"; await seed(id, 30); const jobId = callIdentity(id, "request");
      await db.$transaction(tx => acceptVideoCall(tx, id, jobId, call(id)), options);
      const results = await Promise.all(peers.slice(0, 2).map(peer => peer.$transaction(tx => refundVideoCallCredits(tx, id, jobId, 99), options)));
      assert.equal(new Set(results.map(r => r.transactionId)).size, 1);
      assert.ok(results.every(r => r.refundedCredits === 12));
      assert.equal(await balance(id), 30);
      assert.equal(await db.creditTransaction.count({ where: { user_id: id, type: "refund" } }), 1);
    });
    await check("refund transaction rollback restores balance and permits a subsequent refund", async () => {
      const id = "refund-rollback"; await seed(id, 30); const jobId = callIdentity(id, "request");
      await db.$transaction(tx => acceptVideoCall(tx, id, jobId, call(id)), options);
      await assert.rejects(db.$transaction(async tx => { await refundVideoCallCredits(tx, id, jobId, 12); throw new Error("injected_after_refund"); }, options), /injected_after_refund/);
      assert.equal(await balance(id), 18); assert.deepEqual(await counts(id), { jobs: 1, ledger: 1 });
      await db.$transaction(tx => refundVideoCallCredits(tx, id, jobId, 12), options);
      assert.equal(await balance(id), 30);
    });
    await check("internal test acceptance and refund move zero real credits", async () => {
      const id = "internal"; await seed(id, 0, true); const jobId = callIdentity(id, "request");
      const accepted = await db.$transaction(tx => acceptVideoCall(tx, id, jobId, call(id)), options);
      assert.equal(callView(accepted.job).billing.charged_credits, 0);
      const debit = await db.$transaction(tx => consumeVideoCallCredits(tx, id, jobId, 12), options);
      const refund = await db.$transaction(tx => refundVideoCallCredits(tx, id, jobId, 12), options);
      assert.equal(debit.chargedCredits, 0); assert.equal(debit.billingMode, "internal_test");
      assert.equal(refund.refundedCredits, 0); assert.equal(await balance(id), 0);
      assert.deepEqual(await counts(id), { jobs: 1, ledger: 0 });
    });
  } finally {
    await Promise.all(clients.map(db => db.$disconnect()));
    await rm(passwordFile, { force: true });
    if (startAttempted) {
      try { await command("pg_ctl", ["-D", data, "stop", "-m", "fast", "-w", "-t", "30"]); report.stopped = true; }
      catch { report.stop_failed = true; }
    }
    report.stopped_at = new Date().toISOString();
    report.port_closed = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => { socket.destroy(); resolve(true); });
      socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
    });
    report.residue = "Only this newly created workspace is retained; native binaries and disposable local DB data. No recursive deletion performed.";
    for (const name of ["postgres.log", "native-commands.log"]) await cp(path.join(workspace, name), path.join(artifacts, `video-call-${name}`)).catch(() => undefined);
    await writeFile(path.join(artifacts, "video-call-postgres-result.json"), JSON.stringify(report, null, 2));
    if (startAttempted) { assert.equal(report.stopped, true, "temporary PostgreSQL must stop normally"); assert.equal(report.port_closed, true); }
  }
});
