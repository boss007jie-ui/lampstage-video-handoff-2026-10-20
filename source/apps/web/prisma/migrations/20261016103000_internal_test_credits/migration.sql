-- Internal test exemption is explicit per account; balances and historical ledger stay unchanged.
ALTER TABLE "User" ADD COLUMN "credits_unlimited" BOOLEAN NOT NULL DEFAULT false;
