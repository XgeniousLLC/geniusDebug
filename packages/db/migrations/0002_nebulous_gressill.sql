CREATE TABLE IF NOT EXISTS "github_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"slug" varchar(160) NOT NULL,
	"app_id" varchar(64) NOT NULL,
	"client_id" varchar(128) NOT NULL,
	"client_secret_enc" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"webhook_secret_enc" text,
	"owner_login" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_apps_org_uq" ON "github_apps" USING btree ("org_id");