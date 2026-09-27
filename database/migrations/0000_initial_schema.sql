CREATE TABLE `artifact_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`from_artifact_id` text NOT NULL,
	`to_artifact_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`uri` text NOT NULL,
	`mime_type` text,
	`content_hash` text,
	`size_bytes` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifacts_project_idx` ON `artifacts` (`project_id`);--> statement-breakpoint
CREATE INDEX `artifacts_task_idx` ON `artifacts` (`task_id`);--> statement-breakpoint
CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text NOT NULL,
	`secret_ref` text,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`schema_version` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`task_id` text,
	`project_id` text,
	`correlation_id` text,
	`causation_id` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_idx` ON `events` (`id`);--> statement-breakpoint
CREATE INDEX `events_task_idx` ON `events` (`task_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE INDEX `events_correlation_idx` ON `events` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`enabled` integer NOT NULL,
	`trust` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`content` text NOT NULL,
	`origin` text NOT NULL,
	`confidence` real NOT NULL,
	`project_id` text,
	`task_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_verified_at` integer,
	`expires_at` integer,
	`revision` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_scope_idx` ON `memories` (`project_id`,`status`,`type`);--> statement-breakpoint
CREATE INDEX `memories_task_idx` ON `memories` (`task_id`);--> statement-breakpoint
CREATE TABLE `memory_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`from_memory_id` text NOT NULL,
	`to_memory_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_relations_from_idx` ON `memory_relations` (`from_memory_id`);--> statement-breakpoint
CREATE INDEX `memory_relations_to_idx` ON `memory_relations` (`to_memory_id`);--> statement-breakpoint
CREATE TABLE `memory_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`confidence` real NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_revisions_memory_rev_idx` ON `memory_revisions` (`memory_id`,`revision`);--> statement-breakpoint
CREATE TABLE `memory_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text,
	`excerpt` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_sources_memory_idx` ON `memory_sources` (`memory_id`);--> statement-breakpoint
CREATE TABLE `model_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter` text NOT NULL,
	`locality` text NOT NULL,
	`display_name` text NOT NULL,
	`endpoint` text,
	`secret_ref` text,
	`enabled` integer NOT NULL,
	`state` text NOT NULL,
	`state_message` text,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`task_id` text,
	`purpose` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer NOT NULL,
	`succeeded` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_usage_model_idx` ON `model_usage` (`model_id`);--> statement-breakpoint
CREATE INDEX `model_usage_task_idx` ON `model_usage` (`task_id`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`provider_model_id` text NOT NULL,
	`display_name` text NOT NULL,
	`locality` text NOT NULL,
	`capabilities` text NOT NULL,
	`context_window` integer,
	`available` integer NOT NULL,
	`discovered_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `model_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_model_idx` ON `models` (`provider_id`,`provider_model_id`);--> statement-breakpoint
CREATE TABLE `observations` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`step_id` text,
	`source` text NOT NULL,
	`summary` text NOT NULL,
	`data` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observations_task_idx` ON `observations` (`task_id`);--> statement-breakpoint
CREATE TABLE `permission_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`capability` text NOT NULL,
	`risk_level` text NOT NULL,
	`task_id` text,
	`project_id` text,
	`resource` text,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_scope` text
);
--> statement-breakpoint
CREATE INDEX `permission_requests_status_idx` ON `permission_requests` (`status`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`capability` text NOT NULL,
	`effect` text NOT NULL,
	`scope` text NOT NULL,
	`scope_ref` text,
	`constraints` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `permissions_capability_idx` ON `permissions` (`capability`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`root_path` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `research_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`claim` text NOT NULL,
	`excerpt` text NOT NULL,
	`locator` text,
	`confidence` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `research_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_evidence_source_idx` ON `research_evidence` (`source_id`);--> statement-breakpoint
CREATE TABLE `research_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`uri` text NOT NULL,
	`title` text,
	`retrieved_at` integer NOT NULL,
	`content_hash` text,
	`reliability` real,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`plan_id` text,
	`ordinal` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`tool_execution_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_steps_task_idx` ON `task_steps` (`task_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`paused_from` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE `tool_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`tool_version` text NOT NULL,
	`task_id` text,
	`step_id` text,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`requested_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `tool_executions_task_idx` ON `tool_executions` (`task_id`);--> statement-breakpoint
CREATE INDEX `tool_executions_status_idx` ON `tool_executions` (`status`);--> statement-breakpoint
CREATE TABLE `tool_permissions` (
	`tool_id` text NOT NULL,
	`capability` text NOT NULL,
	`risk_level` text NOT NULL,
	`rationale` text NOT NULL,
	PRIMARY KEY(`tool_id`, `capability`),
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`version` text NOT NULL,
	`category` text NOT NULL,
	`risk_level` text NOT NULL,
	`capabilities` text NOT NULL,
	`input_json_schema` text NOT NULL,
	`output_json_schema` text NOT NULL,
	`availability` text NOT NULL,
	`registered_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
