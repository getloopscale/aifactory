-- A release the factory tags in a repository that publishes from the tag waits for the workflow the tag starts.
ALTER TABLE "publication" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'changesets' NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN IF NOT EXISTS "tag" text;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN IF NOT EXISTS "tag_url" text;
