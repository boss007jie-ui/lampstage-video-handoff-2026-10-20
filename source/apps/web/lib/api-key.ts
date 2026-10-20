import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";

const PREFIX = "lmp_live_";

export function generateApiKey() {
  const secret = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    secret,
    prefix: secret.slice(0, 16),
    hash: hashApiKey(secret),
  };
}

export function hashApiKey(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function tokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers.get("x-api-key")?.trim() || "";
}

/** Authenticate a public API request without using the browser session cookie. */
export async function authenticateApiKey(request: Request) {
  const token = tokenFromRequest(request);
  if (!token || !token.startsWith(PREFIX)) return null;
  let key;
  try {
    key = await prisma.apiKey.findUnique({
      where: { key_hash: hashApiKey(token) },
      include: { user: true },
    });
  } catch {
    // Treat an unavailable credential store as an authentication miss. Never
    // turn database diagnostics into a public API response.
    return null;
  }
  if (!key || key.revoked_at) return null;
  // Do not make a successful request wait on an audit timestamp update.
  void prisma.apiKey.update({
    where: { id: key.id },
    data: { last_used_at: new Date() },
  }).catch(() => undefined);
  return { key, user: key.user };
}

export function publicApiKey(key: { id: string; name: string; key_prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.key_prefix,
    created_at: key.created_at.toISOString(),
    last_used_at: key.last_used_at?.toISOString() ?? null,
    revoked_at: key.revoked_at?.toISOString() ?? null,
  };
}
