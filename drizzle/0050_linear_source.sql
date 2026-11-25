ALTER TABLE "repository" ADD COLUMN "linear_team_id" text;--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "linear_label" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "source" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "display_identifier" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "item_url" text;--> statement-breakpoint
ALTER TABLE "repository" ADD CONSTRAINT "repository_linear_team_id_unique" UNIQUE("linear_team_id");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_source_item_unique" UNIQUE("repository","source","external_id");--> statement-breakpoint
UPDATE "task" SET "external_id" = "issue_number"::text, "display_identifier" = "repository" || '#' || "issue_number", "item_url" = 'https://github.com/' || "repository" || '/issues/' || "issue_number";--> statement-breakpoint
CREATE SEQUENCE "linear_task_ordinal";
