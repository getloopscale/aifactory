-- What the owner writes to an agent from the panel, stored in order with its delivery state.
CREATE TABLE IF NOT EXISTS "agent_message" (
  "id" serial PRIMARY KEY NOT NULL,
  "task_id" integer NOT NULL,
  "role" text NOT NULL,
  "mode" text NOT NULL,
  "text" text NOT NULL,
  "delivery" text DEFAULT 'pending' NOT NULL,
  "failure" text,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_message" ADD CONSTRAINT "agent_message_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
