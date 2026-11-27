CREATE TABLE "code_event" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"tool" text,
	"content" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_event_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "code_session" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"repository" text NOT NULL,
	"base_branch" text NOT NULL,
	"work_branch" text NOT NULL,
	"harness" text NOT NULL,
	"model" text,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"sandbox_id" text,
	"snapshot_id" text,
	"agent_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_event" ADD CONSTRAINT "code_event_session_id_code_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."code_session"("id") ON DELETE no action ON UPDATE no action;
