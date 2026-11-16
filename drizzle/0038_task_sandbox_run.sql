CREATE TABLE "sandbox_lease" (
	"id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"pid" integer NOT NULL,
	"started" text,
	"beat_at" timestamp with time zone NOT NULL,
	"stale_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "sandbox_run" text;