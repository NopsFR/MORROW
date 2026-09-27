ALTER TABLE `task_steps` ADD `expected_tool_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `task_steps` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `result` text;