CREATE TABLE "terminal_session" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"role" text NOT NULL,
	"engine" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"error" text,
	"cost_usd" real
);
--> statement-breakpoint
ALTER TABLE "terminal_session" ADD CONSTRAINT "terminal_session_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "terminal_session_one_open" ON "terminal_session" USING btree ("task_id") WHERE "terminal_session"."closed_at" is null;