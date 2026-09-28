CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`previous_plan_id` text,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`success_criteria` text NOT NULL,
	`kept_step_ids` text DEFAULT '[]' NOT NULL,
	`reason` text,
	`trigger_observation_ids` text DEFAULT '[]' NOT NULL,
	`model_id` text,
	`created_at` integer NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_task_version_idx` ON `plans` (`task_id`,`version`);--> statement-breakpoint
-- Backfill: every task planned before plan versions existed gets its plan as version 1,
-- reconstructed from its PLAN_CREATED event (the previous home of plan metadata).
INSERT INTO `plans` (`id`, `task_id`, `version`, `previous_plan_id`, `status`, `summary`, `success_criteria`, `kept_step_ids`, `reason`, `trigger_observation_ids`, `model_id`, `created_at`, `superseded_at`)
SELECT
	json_extract(e.`payload`, '$.planId'),
	e.`task_id`,
	1,
	NULL,
	'ACTIVE',
	json_extract(e.`payload`, '$.summary'),
	json_extract(e.`payload`, '$.successCriteria'),
	'[]',
	NULL,
	'[]',
	json_extract(e.`payload`, '$.modelId'),
	e.`occurred_at`,
	NULL
FROM `events` e
JOIN `tasks` t ON t.`id` = e.`task_id`
WHERE e.`type` = 'PLAN_CREATED';
