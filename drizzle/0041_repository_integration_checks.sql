ALTER TABLE "repository" ADD COLUMN "integration_checks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "integration_checks_proven_sha" text;--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "integration_checks_proven" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "integration_checks_proof" jsonb;