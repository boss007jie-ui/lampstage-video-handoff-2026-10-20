/**
 * 验证码登录 + cookie session 工具。
 *
 * 设计要点：
 * - 验证码 6 位数字，10 分钟过期，存进 VerificationCode 表（hash 存盘，不存明文）
 * - 验证通过后，新用户自动 grant 20 次额度（在事务里写 CreditTransaction(grant)）
 * - Session：cuid 字符串塞 cookie，30 天有效期；server 端用 Session 表查
 * - 不引入 NextAuth 第三方包，自己实现，控制力最大
 *
 * Dev 环境：发码时把 6 位数字直接 console.log，方便联调；不接短信/邮件网关。
 */
import { cookies } from "next/headers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "./db";

// 有效期单一来源：邮件文案也用它，避免「代码 5 分钟 / 文案 10 分钟」这类漂移。
// 2026-10-13 之前是 5 分钟，实测「发码 → 收信 → 回填」一次往返就超时，故放宽到 10 分钟。
const CODE_TTL_MINUTES = 10;
const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SESSION_COOKIE = "lamp_session";
const NEW_USER_GRANT = 20;
const RATE_LIMIT_MS = 60 * 1000; // 同一 identifier 60 秒内只能发一次
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 6;
const MAX_PASSWORD_LEN = 72; // bcrypt 硬上限

export type IdentifierType = "email" | "phone";

function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function generateCode(): string {
  // 6 位数字，crypto-strong
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0) % 1_000_000;
  return num.toString().padStart(6, "0");
}

function detectType(identifier: string): IdentifierType {
  if (identifier.includes("@")) return "email";
  return "phone";
}

function normalizeIdentifier(identifier: string, type: IdentifierType): string {
  return type === "email" ? identifier.trim().toLowerCase() : identifier.trim();
}

/**
 * 发验证码。返回 { sent: true } 表示已发出；
 * 已发送过且未过期且未消费 → 直接走限流（不重复发）。
 */
export async function sendCode(identifier: string): Promise<{
  sent: boolean;
  reason?: string;
  /** 仅 dev 模式：返回明文验证码方便联调。生产留空。 */
  devCode?: string;
}> {
  const type = detectType(identifier);
  const id = normalizeIdentifier(identifier, type);
  if (!validIdentifier(id, type)) {
    return { sent: false, reason: "invalid_identifier" };
  }

  // 限流：60s 内同一 identifier 不重发
  const recent = await prisma.verificationCode.findFirst({
    where: { identifier: id, type, consumed: false },
    orderBy: { created_at: "desc" },
  });
  if (recent && Date.now() - recent.created_at.getTime() < RATE_LIMIT_MS) {
    return { sent: false, reason: "rate_limited" };
  }

  const code = generateCode();
  const codeHash = hashCode(code, id);
  await prisma.verificationCode.create({
    data: {
      identifier: id,
      code_hash: codeHash,
      type,
      expires_at: new Date(Date.now() + CODE_TTL_MS),
    },
  });

  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.log(`[dev] verification code for ${id}: ${code}`);
    return { sent: true, devCode: code };
  }

  // Production: send email via Resend (only email identifier supported)
  if (type === "email") {
    const { sendVerificationEmail } = await import("@/lib/email");
    const result = await sendVerificationEmail(id, code, CODE_TTL_MINUTES);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`[email] send failed for ${id}: ${result.error}`);
      return { sent: false, reason: "email_send_failed" };
    }
    return { sent: true };
  }

  // Phone path not yet wired up — surface as error rather than silent black hole
  return { sent: false, reason: "phone_not_supported" };
}

/**
 * 验证验证码并完成登录。
 *
 * 成功流程（事务内）：
 * 1. 找到最新未消费、未过期的 code 记录，比对 hash
 * 2. 标记 code consumed
 * 3. upsert User（按 email 或 phone）
 * 4. 如果是新建用户，grant 20 额度 + 写一条 CreditTransaction(grant)
 * 5. 创建 Session
 * 6. 写 cookie
 */
export async function verifyCodeAndSignIn(
  identifier: string,
  code: string,
): Promise<
  | { ok: true; userId: string; isNewUser: boolean; creditBalance: number }
  | { ok: false; reason: "invalid_identifier" | "no_code" | "expired" | "wrong_code" }
> {
  const type = detectType(identifier);
  const id = normalizeIdentifier(identifier, type);
  if (!validIdentifier(id, type)) {
    return { ok: false, reason: "invalid_identifier" };
  }

  const record = await prisma.verificationCode.findFirst({
    where: { identifier: id, type, consumed: false },
    orderBy: { created_at: "desc" },
  });
  if (!record) return { ok: false, reason: "no_code" };
  if (record.expires_at.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const expected = hashCode(code, id);
  const a = Buffer.from(record.code_hash, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "wrong_code" };
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.verificationCode.update({
      where: { id: record.id },
      data: { consumed: true },
    });

    const where = type === "email" ? { email: id } : { phone: id };
    const existing = await tx.user.findUnique({ where });

    let user;
    let isNewUser = false;
    if (existing) {
      user = existing;
    } else {
      isNewUser = true;
      user = await tx.user.create({
        data:
          type === "email"
            ? { email: id, credit_balance: NEW_USER_GRANT }
            : { phone: id, credit_balance: NEW_USER_GRANT },
      });
      await tx.creditTransaction.create({
        data: {
          user_id: user.id,
          type: "grant",
          amount: NEW_USER_GRANT,
          note: "new_user_signup_grant",
        },
      });
    }

    const session = await tx.session.create({
      data: {
        user_id: user.id,
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    return { user, session, isNewUser };
  });

  // 写 cookie（在事务外，cookies() 是请求级的）
  cookies().set(SESSION_COOKIE, result.session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    expires: result.session.expires_at,
  });

  return {
    ok: true,
    userId: result.user.id,
    isNewUser: result.isNewUser,
    creditBalance: result.user.credit_balance,
  };
}

/** 取当前会话用户。未登录或过期返回 null。 */
export async function getCurrentUser() {
  const sid = cookies().get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  const session = await prisma.session.findUnique({
    where: { id: sid },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expires_at.getTime() < Date.now()) return null;
  return session.user;
}

/** 当前用户是否为管理员（基于 ADMIN_EMAILS 环境变量白名单，逗号分隔）。 */
export async function isAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user?.email) return false;
  const list = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(user.email.toLowerCase());
}

/** 退出登录。 */
export async function signOut(): Promise<void> {
  const sid = cookies().get(SESSION_COOKIE)?.value;
  if (sid) {
    // Idempotent for an already-expired session, but never hide a DB failure.
    await prisma.session.deleteMany({ where: { id: sid } });
  }
  cookies().delete(SESSION_COOKIE);
}

function validIdentifier(id: string, type: IdentifierType): boolean {
  if (type === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
  }
  // 简化的国内手机号校验：11 位数字、1 开头
  return /^1\d{10}$/.test(id);
}

function validPassword(pw: string): boolean {
  return (
    typeof pw === "string" &&
    pw.length >= MIN_PASSWORD_LEN &&
    pw.length <= MAX_PASSWORD_LEN
  );
}

async function createSessionAndSetCookie(userId: string): Promise<void> {
  const session = await prisma.session.create({
    data: {
      user_id: userId,
      expires_at: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  cookies().set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    expires: session.expires_at,
  });
}

/**
 * 注册新账号（邮箱 + 密码 + 验证码）。
 *
 * 流程（事务）：
 * 1. 验证邮箱 + 密码 + 验证码格式
 * 2. 验证 verification code
 * 3. 不能与已存在邮箱冲突
 * 4. 创建 user（带 password_hash + email_verified）+ grant 20 额度
 * 5. 写 session cookie
 */
export async function registerWithPassword(
  email: string,
  password: string,
  code: string,
): Promise<
  | { ok: true; userId: string; creditBalance: number }
  | {
      ok: false;
      reason:
        | "invalid_identifier"
        | "weak_password"
        | "no_code"
        | "expired"
        | "wrong_code"
        | "already_registered";
    }
> {
  const id = normalizeIdentifier(email, "email");
  if (!validIdentifier(id, "email")) {
    return { ok: false, reason: "invalid_identifier" };
  }
  if (!validPassword(password)) {
    return { ok: false, reason: "weak_password" };
  }

  const record = await prisma.verificationCode.findFirst({
    where: { identifier: id, type: "email", consumed: false },
    orderBy: { created_at: "desc" },
  });
  if (!record) return { ok: false, reason: "no_code" };
  if (record.expires_at.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  const a = Buffer.from(record.code_hash, "hex");
  const b = Buffer.from(hashCode(code, id), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "wrong_code" };
  }

  // 已存在的邮箱：如果还没设密码 → 视为升级（不重复 grant）
  // 已设密码 → 拒绝（应走登录而不是注册）
  const existing = await prisma.user.findUnique({ where: { email: id } });
  if (existing?.password_hash) {
    return { ok: false, reason: "already_registered" };
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await prisma.$transaction(async (tx) => {
    await tx.verificationCode.update({
      where: { id: record.id },
      data: { consumed: true },
    });

    if (existing) {
      // 老 magic-link 用户升级到带密码：补 password_hash + email_verified，不重复 grant
      const user = await tx.user.update({
        where: { id: existing.id },
        data: { password_hash, email_verified: new Date() },
      });
      return { user, isNewUser: false };
    }

    const user = await tx.user.create({
      data: {
        email: id,
        password_hash,
        email_verified: new Date(),
        credit_balance: NEW_USER_GRANT,
      },
    });
    await tx.creditTransaction.create({
      data: {
        user_id: user.id,
        type: "grant",
        amount: NEW_USER_GRANT,
        note: "new_user_signup_grant",
      },
    });
    return { user, isNewUser: true };
  });

  await createSessionAndSetCookie(result.user.id);

  return {
    ok: true,
    userId: result.user.id,
    creditBalance: result.user.credit_balance,
  };
}

/**
 * 用密码登录（不发码、不查码）。
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<
  | { ok: true; userId: string; creditBalance: number }
  | {
      ok: false;
      reason:
        | "invalid_identifier"
        | "no_account"
        | "no_password_set"
        | "wrong_password";
    }
> {
  const id = normalizeIdentifier(email, "email");
  if (!validIdentifier(id, "email")) {
    return { ok: false, reason: "invalid_identifier" };
  }

  const user = await prisma.user.findUnique({ where: { email: id } });
  if (!user) return { ok: false, reason: "no_account" };
  if (!user.password_hash) return { ok: false, reason: "no_password_set" };

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return { ok: false, reason: "wrong_password" };

  await createSessionAndSetCookie(user.id);
  return {
    ok: true,
    userId: user.id,
    creditBalance: user.credit_balance,
  };
}

/**
 * 检查邮箱是否已存在 + 是否已设密码。
 * 用于前端进入登录窗时判断该走"登录"还是"注册"。
 */
export async function lookupAccountStatus(
  email: string,
): Promise<{ exists: boolean; hasPassword: boolean }> {
  const id = normalizeIdentifier(email, "email");
  if (!validIdentifier(id, "email")) {
    return { exists: false, hasPassword: false };
  }
  const user = await prisma.user.findUnique({
    where: { email: id },
    select: { id: true, password_hash: true },
  });
  return {
    exists: Boolean(user),
    hasPassword: Boolean(user?.password_hash),
  };
}
