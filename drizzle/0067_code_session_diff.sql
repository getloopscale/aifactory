ALTER TABLE "code_session" ADD COLUMN "last_diff" jsonb;--> statement-breakpoint
ALTER TABLE "code_session" ADD COLUMN "last_diff_at" timestamp with time zone;
