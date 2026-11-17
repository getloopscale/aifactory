CREATE TABLE "scheduler_decision" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"head" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "snapshot_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "harness" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "repo_dir" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "base_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ALTER COLUMN "attempt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "origin" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler_decision" ADD CONSTRAINT "scheduler_decision_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduler_decision_readiness_once" ON "scheduler_decision" USING btree ("task_id","kind","head") WHERE "scheduler_decision"."kind" = 'readiness';--> statement-breakpoint
CREATE INDEX "scheduler_decision_task_kind" ON "scheduler_decision" USING btree ("task_id","kind","id");