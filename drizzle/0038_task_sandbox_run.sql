ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "sandbox_run" text;
CREATE TABLE IF NOT EXISTS "sandbox_lease" (
  "id" text PRIMARY KEY NOT NULL,
  "host" text NOT NULL,
  "beat_at" timestamp with time zone NOT NULL
);
