-- A class of defect the reviewer found on several tasks of one repository, and the note written for it.
ALTER TABLE "knowledge_note" ADD COLUMN IF NOT EXISTS "source_tasks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_pattern" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"class_key" text NOT NULL,
	"class_name" text NOT NULL,
	"invariant" text NOT NULL,
	"task_ids" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note_id" integer,
	"proposal_url" text,
	"count_before" integer,
	"count_after" integer,
	"measured_at" timestamp with time zone,
	CONSTRAINT "review_pattern_once" UNIQUE("repository","class_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_pattern" ADD CONSTRAINT "review_pattern_note_id_knowledge_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."knowledge_note"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
