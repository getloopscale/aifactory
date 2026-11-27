-- The factory's own repository moved from `paulohenriquevn/aifactory` to `getloopscale/aifactory` on 2026-11-26.
-- The name is how a row finds its repository and how the factory tells its own work apart, so every table that
-- keeps it takes the new one. A stored address of a pull request or an issue keeps the old owner: GitHub
-- redirects it.
UPDATE "repository" SET "full_name" = 'getloopscale/aifactory' WHERE "full_name" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "external_review" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "failure_signature" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "improver_decision" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "ingress" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "knowledge_curation" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "knowledge_gap" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "knowledge_note" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "line_incident" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "metric_point" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "metric_signal" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "plan" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "promotion_finding" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "promotion_wait" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "publication" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "release_wait" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "review_pattern" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "task" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "watch" SET "repository" = 'getloopscale/aifactory' WHERE "repository" = 'paulohenriquevn/aifactory';
--> statement-breakpoint
UPDATE "external_review" SET "head_repository" = 'getloopscale/aifactory' WHERE "head_repository" = 'paulohenriquevn/aifactory';
