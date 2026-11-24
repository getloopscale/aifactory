-- A task names its work item by source and external id (#471). Every task so far is a GitHub issue.
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "external_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "external_display" text;--> statement-breakpoint
UPDATE "task" SET "external_id" = "repository" || '#' || "issue_number" WHERE "external_id" = '';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "task_external_id"() RETURNS trigger AS $$ BEGIN IF NEW."external_id" = '' THEN NEW."external_id" := NEW."repository" || '#' || NEW."issue_number"; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "task_external_id" ON "task";--> statement-breakpoint
CREATE TRIGGER "task_external_id" BEFORE INSERT ON "task" FOR EACH ROW EXECUTE FUNCTION "task_external_id"();--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_source_item_unique" UNIQUE("source","external_id");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_source_number_range" CHECK (("source" = 'github' AND "issue_number" < 1000000000) OR ("source" = 'linear' AND "issue_number" >= 1000000000));--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "linear_task_number" START WITH 1000000000;
