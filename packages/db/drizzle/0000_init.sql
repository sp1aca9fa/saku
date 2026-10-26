CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `activity_log_at_idx` ON `activity_log` (`at`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `backup_codes_user_idx` ON `backup_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `bar_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol_id` integer NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`field` text NOT NULL,
	`old_value` real,
	`new_value` real,
	`detected_at` text NOT NULL,
	`run_id` text,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bar_revisions_field_check" CHECK("bar_revisions"."field" IN ('open', 'high', 'low', 'close', 'close_is_split_adjusted', 'volume', 'div_cash', 'split_factor'))
);
--> statement-breakpoint
CREATE INDEX `bar_revisions_symbol_idx` ON `bar_revisions` (`symbol_id`,`date`);--> statement-breakpoint
CREATE TABLE `bars` (
	`symbol_id` integer NOT NULL,
	`date` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real NOT NULL,
	`volume` real,
	`div_cash` real DEFAULT 0 NOT NULL,
	`split_factor` real DEFAULT 1 NOT NULL,
	`adj_close` real,
	`source` text NOT NULL,
	`stand_in` integer DEFAULT false NOT NULL,
	`status` text,
	PRIMARY KEY(`symbol_id`, `date`),
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bars_status_check" CHECK("bars"."status" IS NULL OR "bars"."status" IN ('green', 'yellow', 'red'))
);
--> statement-breakpoint
CREATE TABLE `bars_raw` (
	`symbol_id` integer NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real NOT NULL,
	`close_is_split_adjusted` integer DEFAULT false NOT NULL,
	`volume` real,
	`div_cash` real DEFAULT 0 NOT NULL,
	`split_factor` real DEFAULT 1 NOT NULL,
	`provider_adj_close` real,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`symbol_id`, `date`, `source`),
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`layer` text NOT NULL,
	`check_name` text NOT NULL,
	`symbol_id` integer,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`observed` real,
	`expected` real,
	`tolerance` real,
	`message` text,
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "check_results_layer_check" CHECK("check_results"."layer" IN ('A', 'B', 'C', 'D', 'E')),
	CONSTRAINT "check_results_status_check" CHECK("check_results"."status" IN ('green', 'yellow', 'red'))
);
--> statement-breakpoint
CREATE INDEX `check_results_run_idx` ON `check_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `check_results_date_idx` ON `check_results` (`date`,`symbol_id`);--> statement-breakpoint
CREATE TABLE `check_summaries` (
	`run_id` text NOT NULL,
	`layer` text NOT NULL,
	`check_name` text NOT NULL,
	`checked` integer NOT NULL,
	`passed` integer NOT NULL,
	`max_deviation` real,
	PRIMARY KEY(`run_id`, `layer`, `check_name`),
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "check_summaries_layer_check" CHECK("check_summaries"."layer" IN ('A', 'B', 'C', 'D', 'E'))
);
--> statement-breakpoint
CREATE TABLE `data_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`date` text NOT NULL,
	`symbol_id` integer,
	`status` text NOT NULL,
	`reasons` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "data_health_status_check" CHECK("data_health"."status" IN ('green', 'yellow', 'red'))
);
--> statement-breakpoint
CREATE INDEX `data_health_date_idx` ON `data_health` (`date`,`symbol_id`);--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`pair` text NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`rate` real NOT NULL,
	`published_at` text,
	`fetched_at` text NOT NULL,
	`known_at` text NOT NULL,
	PRIMARY KEY(`pair`, `kind`, `date`, `source`, `known_at`, `fetched_at`),
	CONSTRAINT "fx_rates_kind_check" CHECK("fx_rates"."kind" IN ('valuation', 'tax_mid', 'tax_buy', 'tax_sell'))
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`dates_processed` text,
	`error` text,
	`heartbeat_sent` integer DEFAULT false NOT NULL,
	CONSTRAINT "job_runs_type_check" CHECK("job_runs"."job_type" IN ('daily', 'weekly', 'monthly', 'bootstrap')),
	CONSTRAINT "job_runs_status_check" CHECK("job_runs"."status" IN ('running', 'success', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `job_runs_started_idx` ON `job_runs` (`job_type`,`started_at`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ip_hash` text NOT NULL,
	`username_hash` text,
	`attempted_at` text NOT NULL,
	`success` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_ip_idx` ON `login_attempts` (`ip_hash`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `login_attempts_user_idx` ON `login_attempts` (`username_hash`,`attempted_at`);--> statement-breakpoint
CREATE INDEX `login_attempts_time_idx` ON `login_attempts` (`attempted_at`);--> statement-breakpoint
CREATE TABLE `plugin_info` (
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`saved_at` text NOT NULL,
	PRIMARY KEY(`key`, `kind`),
	CONSTRAINT "plugin_info_kind_check" CHECK("plugin_info"."kind" IN ('bar', 'series', 'fx', 'tax_fx', 'issuer', 'event_calendar', 'tax_regime', 'calendar'))
);
--> statement-breakpoint
CREATE TABLE `provider_usage` (
	`provider` text NOT NULL,
	`window_type` text NOT NULL,
	`window_start` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`symbols` text NOT NULL,
	PRIMARY KEY(`provider`, `window_type`, `window_start`),
	CONSTRAINT "provider_usage_window_check" CHECK("provider_usage"."window_type" IN ('minute', 'hour', 'day', 'month'))
);
--> statement-breakpoint
CREATE TABLE `readjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol_id` integer NOT NULL,
	`source` text NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`factor` real NOT NULL,
	`detected_at` text NOT NULL,
	`run_id` text,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `readjustments_symbol_idx` ON `readjustments` (`symbol_id`,`source`);--> statement-breakpoint
CREATE TABLE `series` (
	`series` text NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`value` real NOT NULL,
	`published_at` text,
	`fetched_at` text NOT NULL,
	`known_at` text NOT NULL,
	PRIMARY KEY(`series`, `date`, `source`, `known_at`, `fetched_at`)
);
--> statement-breakpoint
CREATE TABLE `source_roles` (
	`data_kind` text NOT NULL,
	`plugin_key` text NOT NULL,
	`role` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`data_kind`, `plugin_key`),
	CONSTRAINT "source_roles_role_check" CHECK("source_roles"."role" IN ('primary', 'secondary', 'check'))
);
--> statement-breakpoint
CREATE TABLE `symbols` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`tier` integer NOT NULL,
	`asset_class` text NOT NULL,
	`currency` text NOT NULL,
	`exchange` text,
	`leverage_factor` real DEFAULT 1 NOT NULL,
	`underlying_symbol_id` integer,
	`issuer` text,
	`inception_date` text,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`underlying_symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbols_ticker_uq` ON `symbols` (`ticker`);--> statement-breakpoint
CREATE TABLE `user_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `user_devices_user_idx` ON `user_devices` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`example_amount` text,
	`example_currency` text,
	`defaults` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`totp_secret_enc` text,
	`totp_last_step` integer,
	`is_admin` integer DEFAULT false NOT NULL,
	`disabled_at` text,
	`language` text,
	`setup_token_hash` text,
	`setup_expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);