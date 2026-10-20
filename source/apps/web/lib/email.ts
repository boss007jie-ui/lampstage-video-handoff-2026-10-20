/**
 * 邮件发送 helper — 走 Resend.
 *
 * 配置环境变量：
 *   RESEND_API_KEY=*** RESEND_FROM=Lampstage <hello@lampstage.com>
 *
 * 没配 key 时降级：在控制台打印验证码（不抛错），让 dev 也能用。
 *
 * 生产到 Vercel 之前必须把 RESEND_API_KEY 设进 Vercel env。
 */
import { Resend } from "resend";
import { BRAND } from "@/lib/brand";

let resend: Resend | null = null;
function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!resend) resend = new Resend(key);
  return resend;
}

export type SendResult = {
  ok: boolean;
  error?: string;
  /** 没配 SMTP 时控制台打印了 code，dev 模式可继续 */
  fallback?: boolean;
};

export async function sendVerificationEmail(
  to: string,
  code: string,
  /**
   * 有效期（分钟）。由调用方传入，不在这里写死 ——
   * 历史上这里硬编码「10 minutes」而 VerificationCode 实际只活 5 分钟，文案与实现漂移。
   * 现在唯一来源是 lib/auth.ts 的 CODE_TTL_MINUTES。
   */
  ttlMinutes: number,
): Promise<SendResult> {
  const client = getResend();
  if (!client) {
    // No API key — print to server log so we don't deadlock dev.
    // eslint-disable-next-line no-console
    console.warn(
      `[email] RESEND_API_KEY not set; would have sent code ${code} to ${to}`,
    );
    return { ok: true, fallback: true };
  }

  const from = process.env.RESEND_FROM || `Lampstage <onboarding@resend.dev>`;
  const subject = `${BRAND.en} sign-in code: ${code}`;

  const html = `
  <div style="font-family: -apple-system, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #061b31;">
    <div style="margin-bottom: 24px; font-size: 14px; color: #94a3b8; letter-spacing: 0.05em;">
      ${BRAND.en} · ${BRAND.cn}
    </div>
    <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 12px; color: #061b31;">
      Your sign-in code · 你的验证码
    </h1>
    <p style="font-size: 14px; color: #64748d; margin: 0 0 24px;">
      Enter this 6-digit code to finish signing in. It expires in ${ttlMinutes} minutes.<br/>
      请输入下方 6 位验证码完成登录，${ttlMinutes} 分钟内有效。
    </p>
    <div style="font-family: 'SF Mono', 'Cascadia Mono', Menlo, monospace; font-size: 36px; font-weight: 700; letter-spacing: 6px; color: #533afd; padding: 20px; background: #faf7ed; border: 1px solid #eadfcb; border-radius: 12px; text-align: center; margin-bottom: 24px;">
      ${code}
    </div>
    <p style="font-size: 12px; color: #94a3b8; margin: 0;">
      If you didn't request this, you can ignore this email.<br/>
      如果你没有发起此次登录请求，可以忽略此邮件。
    </p>
    <hr style="border: none; border-top: 1px solid #e5edf5; margin: 32px 0 16px;" />
    <p style="font-size: 11px; color: #94a3b8; margin: 0;">
      ${BRAND.en} · ${BRAND.domain} · AI scene-photography for lamp sellers.
    </p>
  </div>
  `.trim();

  const text =
    `${BRAND.en} · ${BRAND.cn}\n\n` +
    `Your sign-in code: ${code}\n` +
    `验证码: ${code}\n\n` +
    `It expires in ${ttlMinutes} minutes. ${ttlMinutes} 分钟内有效。\n\n` +
    `If you didn't request this, ignore this email.\n` +
    `如果你没有发起此次登录请求，可以忽略此邮件。\n\n` +
    `— ${BRAND.en}, ${BRAND.domain}`;

  try {
    const r = await client.emails.send({
      from,
      to,
      subject,
      html,
      text,
    });
    if (r.error) {
      return { ok: false, error: String(r.error.message ?? r.error) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
