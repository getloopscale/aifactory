CREATE TABLE "promotion_wait" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"pull_request_url" text NOT NULL,
	"sha" text NOT NULL,
	"hold_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "integration_held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_wait_one_per_repository" ON "promotion_wait" USING btree ("repository") WHERE "promotion_wait"."status" = 'waiting';