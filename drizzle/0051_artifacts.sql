CREATE TABLE "evidence_artifact" (
	"id" serial PRIMARY KEY NOT NULL,
	"evidence_id" integer NOT NULL,
	"task_id" integer NOT NULL,
	"sha" text NOT NULL,
	"path" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "omitted" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "sandbox_image" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_artifact" ADD CONSTRAINT "evidence_artifact_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_artifact" ADD CONSTRAINT "evidence_artifact_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_artifact_task_id" ON "evidence_artifact" USING btree ("task_id","id");