import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cp, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const DIRECTORY_PREFIX = "lamp-agent-pg-";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port available");
  await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function postgresEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const name of ["SystemRoot", "WINDIR", "PATH", "PATHEXT"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

async function postgresCommand(
  executable: string,
  args: string[],
  workspace: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace,
      env: postgresEnvironment(),
      windowsHide: true,
      stdio: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Embedded PostgreSQL command could not start"));
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Embedded PostgreSQL command timed out"));
      else if (code === 0) resolve();
      else reject(new Error("Embedded PostgreSQL command failed"));
    });
  });
}

/** Calls run with a fresh, local PostgreSQL URL. run must disconnect its own clients. */
export async function withIsolatedAgentPostgres<T>(
  run: (url: string) => Promise<T>,
): Promise<T> {
  const tempRoot = path.resolve(os.tmpdir());
  if (!/^[\x00-\x7F]+$/.test(tempRoot)) {
    throw new Error("Embedded PostgreSQL requires an ASCII temp path");
  }
  const verifiedRoot = await realpath(tempRoot);
  if (path.resolve(verifiedRoot) !== tempRoot) {
    throw new Error("Embedded PostgreSQL temp path must resolve directly");
  }

  const workspace = await mkdtemp(path.join(tempRoot, DIRECTORY_PREFIX));
  const native = path.join(workspace, "native");
  const data = path.join(workspace, "data");
  const passwordFile = path.join(workspace, "password.tmp");
  let startAttempted = false;
  const bin = (name: string) => path.join(native, "bin", `${name}.exe`);
  const command = (name: string, args: string[]) =>
    postgresCommand(bin(name), args, workspace);

  const cleanup = async () => {
    // A failed or timed-out start can still leave a server running. Never delete
    // its data directory unless pg_ctl confirms that it has stopped.
    if (startAttempted) {
      await command("pg_ctl", ["-D", data, "stop", "-m", "fast", "-w", "-t", "30"]);
    }
    const resolved = path.resolve(workspace);
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
        path.dirname(resolved) !== tempRoot ||
        !path.basename(resolved).startsWith(DIRECTORY_PREFIX) ||
        await realpath(resolved) !== resolved) {
      throw new Error("Refusing to remove an unexpected PostgreSQL temp directory");
    }
    // Windows may briefly retain a handle after pg_ctl reports a successful stop.
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    const nativeSource = path.resolve(
      path.dirname(require.resolve("@embedded-postgres/windows-x64")), "..", "native",
    );
    await cp(nativeSource, native, { recursive: true });
    const password = randomBytes(32).toString("hex");
    const port = await freeLoopbackPort();
    await writeFile(passwordFile, password, { mode: 0o600 });
    await command("initdb", ["-D", data, "-U", "agent_test", "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C"]);
    await rm(passwordFile);
    startAttempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(workspace, "postgres.log"),
      "-o", `-p ${port} -h 127.0.0.1`, "start", "-w", "-t", "30"]);
    const url = `postgresql://agent_test:${password}@127.0.0.1:${port}/postgres?schema=public`;
    return await run(url);
  } finally {
    await cleanup();
  }
}
