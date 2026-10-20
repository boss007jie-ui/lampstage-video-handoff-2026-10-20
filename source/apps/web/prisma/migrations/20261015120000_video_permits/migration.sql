CREATE TABLE "VideoPermitAccount" (
    "id" TEXT NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "VideoPermitAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VideoPermit" (
    "attempt_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "segment_index" INTEGER NOT NULL,
    "reserved_coins" INTEGER,
    "max_coins" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "unknown_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    CONSTRAINT "VideoPermit_pkey" PRIMARY KEY ("attempt_id"),
    CONSTRAINT "VideoPermit_status_check" CHECK ("status" IN ('active', 'unknown', 'released')),
    CONSTRAINT "VideoPermit_segment_index_check" CHECK ("segment_index" >= 0),
    CONSTRAINT "VideoPermit_max_coins_check" CHECK ("max_coins" >= 0),
    CONSTRAINT "VideoPermit_reserved_coins_check" CHECK ("reserved_coins" IS NULL OR "reserved_coins" >= 0)
);

CREATE INDEX "VideoPermit_account_id_status_idx" ON "VideoPermit"("account_id", "status");
CREATE INDEX "VideoPermit_job_id_segment_index_idx" ON "VideoPermit"("job_id", "segment_index");
ALTER TABLE "VideoPermit" ADD CONSTRAINT "VideoPermit_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "VideoPermitAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- This account identity is stable across API-key rotation. An older worker may
-- already have submitted paid work without a permit. Quarantine those receipts
-- before a new worker can acquire any account slot.
INSERT INTO "VideoPermitAccount" ("id") VALUES ('runninghub.account01') ON CONFLICT ("id") DO NOTHING;

WITH legacy_segments AS (
    SELECT j."id" AS job_id, j."data", s.segment, s.ordinality,
      CASE
        WHEN jsonb_typeof(s.segment->'index') = 'number'
          AND (s.segment->>'index') ~ '^[0-9]+$'
          AND length(s.segment->>'index') <= 10
        THEN CASE WHEN (s.segment->>'index')::numeric <= 2147483647
          THEN (s.segment->>'index')::integer ELSE (s.ordinality - 1)::integer END
        ELSE (s.ordinality - 1)::integer
      END AS segment_index,
      CASE
        WHEN jsonb_typeof(s.segment->'attempt') = 'number'
          AND (s.segment->>'attempt') ~ '^[0-9]+$'
          AND length(s.segment->>'attempt') <= 10
        THEN CASE WHEN (s.segment->>'attempt')::numeric <= 2147483647
          THEN (s.segment->>'attempt')::integer ELSE 0 END
        ELSE 0
      END AS attempt_number
    FROM "VideoJob" j
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(j."data"->'segments') = 'array'
        THEN j."data"->'segments' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS s(segment, ordinality)
    WHERE jsonb_typeof(s.segment) = 'object'
      AND NOT coalesce(
        jsonb_typeof(s.segment->'candidateKey') = 'string'
          AND nullif(btrim(s.segment->>'candidateKey'), '') IS NOT NULL, false)
      AND (nullif(btrim(s.segment->>'buildId'), '') IS NOT NULL
        OR nullif(btrim(s.segment->>'submissionIntentAt'), '') IS NOT NULL)
), legacy_budget AS (
    SELECT *, CASE
      WHEN jsonb_typeof("data"#>'{renderConsent,maxCoins}') = 'number'
        AND ("data"#>>'{renderConsent,maxCoins}') ~ '^[0-9]+$'
        AND length("data"#>>'{renderConsent,maxCoins}') <= 10
      THEN CASE WHEN ("data"#>>'{renderConsent,maxCoins}')::numeric <= 2147483647
        THEN ("data"#>>'{renderConsent,maxCoins}')::integer ELSE 0 END
      ELSE 0
    END AS max_coins
    FROM legacy_segments
)
INSERT INTO "VideoPermit" (
  "attempt_id", "account_id", "job_id", "segment_index", "reserved_coins", "max_coins",
  "status", "created_at", "updated_at", "unknown_at"
)
SELECT job_id || ':' || segment_index || ':' || attempt_number,
  'runninghub.account01', job_id, segment_index, NULL, max_coins,
  'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM legacy_budget
ON CONFLICT ("attempt_id") DO NOTHING;

ALTER TABLE "VideoWorker" ADD COLUMN "sixref_ready" BOOLEAN NOT NULL DEFAULT false;
