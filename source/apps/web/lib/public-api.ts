import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-key";

export function apiJson(value: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(value, { ...init, headers });
}

export async function requireApiUser(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) {
    return { response: apiJson({ error: "invalid_api_key", message: "请在 Authorization: Bearer <key> 中提供有效的 API Key。" }, { status: 401 }) } as const;
  }
  return { auth } as const;
}
