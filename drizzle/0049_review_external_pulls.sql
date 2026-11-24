CREATE TABLE "pull_review" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"detail" text,
	"github_review_id" text,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "pull_review_id" integer;--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "review_external_pulls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_review_head" ON "pull_review" USING btree ("repository","pull_number","head_sha");