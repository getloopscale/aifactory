CREATE TABLE "agent_message" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"role" text DEFAULT 'builder' NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"mode" text NOT NULL,
	"delivery" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"answer" text,
	"answered_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"cost_usd" real
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "conversation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_message" ADD CONSTRAINT "agent_message_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_message_task_delivery" ON "agent_message" USING btree ("task_id","delivery","id");