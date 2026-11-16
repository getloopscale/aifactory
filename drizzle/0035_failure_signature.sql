CREATE TABLE "failure_signature" (
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"repository" text NOT NULL,
	"issue_number" integer,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"count_before" integer,
	"count_after" integer,
	"measured_at" timestamp with time zone,
	CONSTRAINT "failure_signature_signature_unique" UNIQUE("signature")
);
