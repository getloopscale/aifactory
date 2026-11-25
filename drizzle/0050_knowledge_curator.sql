CREATE TABLE "knowledge_curation" (
	"id" serial PRIMARY KEY NOT NULL,
	"knowledge_repository" text NOT NULL,
	"repository" text NOT NULL,
	"action" text NOT NULL,
	"mode" text NOT NULL,
	"group_key" text NOT NULL,
	"status" text NOT NULL,
	"memory_sha" text,
	"detail" jsonb NOT NULL,
	"commit_sha" text,
	"pull_number" integer,
	"pull_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_curation_once" ON "knowledge_curation" USING btree ("knowledge_repository","repository","mode","action","group_key");--> statement-breakpoint
CREATE INDEX "knowledge_curation_status" ON "knowledge_curation" USING btree ("status","id");
