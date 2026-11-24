-- What a check wrote at its declared paths, kept for the commit it ran on, and the image a repository's sandboxes
-- use. Every repository starts on the default image.
ALTER TABLE "repository" ADD COLUMN IF NOT EXISTS "sandbox_image" text DEFAULT 'default' NOT NULL;
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "omitted" jsonb DEFAULT '[]'::jsonb NOT NULL;
CREATE TABLE IF NOT EXISTS "evidence_artifact" (
  "id" serial PRIMARY KEY NOT NULL,
  "evidence_id" integer NOT NULL REFERENCES "evidence"("id") ON DELETE CASCADE,
  "task_id" integer NOT NULL REFERENCES "task"("id"),
  "sha" text NOT NULL,
  "path" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "content" bytea NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "evidence_artifact_task_id" ON "evidence_artifact" USING btree ("task_id","id");
