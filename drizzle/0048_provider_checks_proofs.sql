-- The last completed proof of a repository's checks on each sandbox provider. A proof stored before this
-- has no provider, and is not guessed at: every provider starts untried.
ALTER TABLE "repository" ADD COLUMN IF NOT EXISTS "checks_proof_by_provider" jsonb DEFAULT '{}'::jsonb NOT NULL;
