-- What an agent needed to know and the knowledge base did not say: one row per question in a project, and one
-- per task that asked it.
CREATE TABLE IF NOT EXISTS "knowledge_gap" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"question" text NOT NULL,
	"question_hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "knowledge_gap_once" UNIQUE("repository","question_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_gap_task" (
	"id" serial PRIMARY KEY NOT NULL,
	"gap_id" integer NOT NULL,
	"task_id" integer NOT NULL,
	"issue_number" integer NOT NULL,
	"role" text NOT NULL,
	"base_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_gap_task_once" UNIQUE("gap_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_gap_task" ADD CONSTRAINT "knowledge_gap_task_gap_id_knowledge_gap_id_fk" FOREIGN KEY ("gap_id") REFERENCES "public"."knowledge_gap"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_gap_task" ADD CONSTRAINT "knowledge_gap_task_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;
