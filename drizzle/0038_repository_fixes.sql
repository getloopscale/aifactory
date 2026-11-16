ALTER TABLE "repository" ADD COLUMN IF NOT EXISTS "fixes" jsonb DEFAULT '[]'::jsonb NOT NULL;
