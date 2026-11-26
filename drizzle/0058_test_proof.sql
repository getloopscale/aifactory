CREATE TABLE "test_proof" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"sha" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_proof" ADD CONSTRAINT "test_proof_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "test_proof_task_sha" ON "test_proof" USING btree ("task_id","sha");