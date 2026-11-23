CREATE TABLE "line_incident" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"cause" text NOT NULL,
	"surface" text NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_url" text NOT NULL,
	"last_sha" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "line_incident_one_per_repository" ON "line_incident" USING btree ("repository") WHERE "line_incident"."status" <> 'resolved';