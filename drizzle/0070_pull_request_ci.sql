CREATE TABLE "pull_request_ci" (
	"task_id" integer PRIMARY KEY NOT NULL,
	"pull_request_url" text NOT NULL,
	"head_sha" text NOT NULL,
	"pull_state" text NOT NULL,
	"checks" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_request_ci" ADD CONSTRAINT "pull_request_ci_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;