CREATE TABLE "coordinator_action" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"exception_kind" text NOT NULL,
	"head_sha" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"draft" jsonb,
	"outcome" text NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coordinator_action_once_per_head" UNIQUE("task_id","exception_kind","head_sha")
);
--> statement-breakpoint
ALTER TABLE "coordinator_action" ADD CONSTRAINT "coordinator_action_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;