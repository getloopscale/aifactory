-- The owner's list of risky path patterns for a repository (#470). Empty means the factory's defaults.
ALTER TABLE "repository" ADD COLUMN IF NOT EXISTS "risk_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL;
