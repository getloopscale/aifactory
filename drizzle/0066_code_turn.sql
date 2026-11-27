ALTER TABLE "agent_run" ADD COLUMN "code_session_id" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "code_message_seq" integer;--> statement-breakpoint
ALTER TABLE "code_session" ADD COLUMN "agent_session_harness" text;