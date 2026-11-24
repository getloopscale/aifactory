-- The risk level of a change at each reviewed commit, and the repository's own path patterns for it.
CREATE TABLE IF NOT EXISTS "task_risk" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"sha" text NOT NULL,
	"level" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_risk" ADD CONSTRAINT "task_risk_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_risk_one_per_commit" ON "task_risk" USING btree ("task_id","sha");--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN IF NOT EXISTS "risk_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL;
