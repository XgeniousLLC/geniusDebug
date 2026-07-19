CREATE TABLE IF NOT EXISTS "fix_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"event_id" uuid,
	"model" varchar(80) NOT NULL,
	"root_cause" text NOT NULL,
	"confidence" varchar(12) NOT NULL,
	"explanation" text,
	"evidence" jsonb DEFAULT '[]'::jsonb,
	"patches" jsonb DEFAULT '[]'::jsonb,
	"test_suggestion" text,
	"need_more_context" jsonb DEFAULT '[]'::jsonb,
	"meta" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fix_suggestions" ADD CONSTRAINT "fix_suggestions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fix_suggestions" ADD CONSTRAINT "fix_suggestions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fix_suggestions_issue_idx" ON "fix_suggestions" USING btree ("issue_id","created_at");