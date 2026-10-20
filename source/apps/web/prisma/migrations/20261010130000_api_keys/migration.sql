-- Additive API key storage for WorkBuddy and server-side integrations.
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'WorkBuddy',
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiKey_key_hash_key" ON "ApiKey"("key_hash");
CREATE INDEX "ApiKey_user_id_created_at_idx" ON "ApiKey"("user_id", "created_at");
CREATE INDEX "ApiKey_user_id_revoked_at_idx" ON "ApiKey"("user_id", "revoked_at");
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
