CREATE TABLE "improver_decision" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"signature" text,
	"issue_number" integer,
	"proposal" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "failure_signature" DROP CONSTRAINT "failure_signature_signature_unique";--> statement-breakpoint
CREATE INDEX "improver_decision_repository" ON "improver_decision" USING btree ("repository","id");--> statement-breakpoint
CREATE UNIQUE INDEX "failure_signature_repository_signature" ON "failure_signature" USING btree ("repository","signature");