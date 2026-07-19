CREATE TABLE IF NOT EXISTS "fix_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggestion_id" uuid NOT NULL,
	"patch_hash" varchar(64) NOT NULL,
	"branch" varchar(240) NOT NULL,
	"pr_url" text NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "pr_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fix_pull_requests" ADD CONSTRAINT "fix_pull_requests_suggestion_id_fix_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."fix_suggestions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fix_pull_requests" ADD CONSTRAINT "fix_pull_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fix_prs_suggestion_patch_uq" ON "fix_pull_requests" USING btree ("suggestion_id","patch_hash");