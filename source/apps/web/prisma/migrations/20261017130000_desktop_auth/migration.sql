-- 桌面身份独立表，旧表只增加外键引用，无令牌原文。
CREATE TABLE "DesktopAuthFamily" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "scopes" TEXT[] NOT NULL,
  "deviceLabel" TEXT,
  "createdAt" BIGINT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "idleExpiresAt" BIGINT NOT NULL,
  "generation" INTEGER NOT NULL CHECK ("generation" > 0),
  "revokedAt" BIGINT,
  CONSTRAINT "DesktopAuthFamily_time_check" CHECK (
    "createdAt" >= 0 AND "expiresAt" > "createdAt" AND "expiresAt" <= 9007199254740991
    AND "idleExpiresAt" >= "createdAt" AND "idleExpiresAt" <= "expiresAt"
    AND ("revokedAt" IS NULL OR ("revokedAt" >= 0 AND "revokedAt" <= 9007199254740991))
  ),
  CONSTRAINT "DesktopAuthFamily_scopes_check" CHECK (
    cardinality("scopes") BETWEEN 1 AND 8 AND array_ndims("scopes") = 1 AND array_position("scopes", NULL) IS NULL
    AND "scopes" <@ ARRAY['account.read','model.execute','assets.read','assets.write','images.read','images.propose','images.approve','images.submit']::TEXT[]
    AND cardinality(array_positions("scopes", 'account.read')) <= 1 AND cardinality(array_positions("scopes", 'model.execute')) <= 1
    AND cardinality(array_positions("scopes", 'assets.read')) <= 1 AND cardinality(array_positions("scopes", 'assets.write')) <= 1
    AND cardinality(array_positions("scopes", 'images.read')) <= 1 AND cardinality(array_positions("scopes", 'images.propose')) <= 1
    AND cardinality(array_positions("scopes", 'images.approve')) <= 1 AND cardinality(array_positions("scopes", 'images.submit')) <= 1
  )
);
CREATE INDEX "DesktopAuthFamily_accountId_expiresAt_idx" ON "DesktopAuthFamily"("accountId", "expiresAt");
CREATE INDEX "DesktopAuthFamily_expiresAt_idx" ON "DesktopAuthFamily"("expiresAt");

CREATE TABLE "DesktopAuthCode" (
  "hash" CHAR(64) NOT NULL PRIMARY KEY CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  "accountId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "redirectUri" TEXT NOT NULL,
  "challenge" VARCHAR(43) NOT NULL CHECK ("challenge" ~ '^[A-Za-z0-9_-]{43}$'),
  "scopes" TEXT[] NOT NULL,
  "deviceLabel" TEXT,
  "expiresAt" BIGINT NOT NULL CHECK ("expiresAt" > 0 AND "expiresAt" <= 9007199254740991),
  "consumedFamilyId" TEXT REFERENCES "DesktopAuthFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DesktopAuthCode_scopes_check" CHECK (
    cardinality("scopes") BETWEEN 1 AND 8 AND array_ndims("scopes") = 1 AND array_position("scopes", NULL) IS NULL
    AND "scopes" <@ ARRAY['account.read','model.execute','assets.read','assets.write','images.read','images.propose','images.approve','images.submit']::TEXT[]
    AND cardinality(array_positions("scopes", 'account.read')) <= 1 AND cardinality(array_positions("scopes", 'model.execute')) <= 1
    AND cardinality(array_positions("scopes", 'assets.read')) <= 1 AND cardinality(array_positions("scopes", 'assets.write')) <= 1
    AND cardinality(array_positions("scopes", 'images.read')) <= 1 AND cardinality(array_positions("scopes", 'images.propose')) <= 1
    AND cardinality(array_positions("scopes", 'images.approve')) <= 1 AND cardinality(array_positions("scopes", 'images.submit')) <= 1
  )
);
CREATE INDEX "DesktopAuthCode_accountId_expiresAt_idx" ON "DesktopAuthCode"("accountId", "expiresAt");
CREATE INDEX "DesktopAuthCode_expiresAt_idx" ON "DesktopAuthCode"("expiresAt");
CREATE INDEX "DesktopAuthCode_consumedFamilyId_idx" ON "DesktopAuthCode"("consumedFamilyId");

CREATE TABLE "DesktopAuthRefresh" (
  "hash" CHAR(64) NOT NULL PRIMARY KEY CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  "familyId" TEXT NOT NULL REFERENCES "DesktopAuthFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "generation" INTEGER NOT NULL CHECK ("generation" > 0),
  "used" BOOLEAN NOT NULL
);
CREATE INDEX "DesktopAuthRefresh_familyId_idx" ON "DesktopAuthRefresh"("familyId");

CREATE TABLE "DesktopAuthAccess" (
  "hash" CHAR(64) NOT NULL PRIMARY KEY CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  "familyId" TEXT NOT NULL REFERENCES "DesktopAuthFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "generation" INTEGER NOT NULL CHECK ("generation" > 0),
  "expiresAt" BIGINT NOT NULL CHECK ("expiresAt" > 0 AND "expiresAt" <= 9007199254740991)
);
CREATE INDEX "DesktopAuthAccess_familyId_idx" ON "DesktopAuthAccess"("familyId");
CREATE INDEX "DesktopAuthAccess_expiresAt_idx" ON "DesktopAuthAccess"("expiresAt");
