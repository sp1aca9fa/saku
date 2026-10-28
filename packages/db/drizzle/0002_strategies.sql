CREATE TABLE `chain_anchors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chain_head_hash` text NOT NULL,
	`heads` text NOT NULL,
	`anchored_at` text NOT NULL,
	`method` text NOT NULL,
	`authority` text,
	`proof` blob
);
--> statement-breakpoint
CREATE TABLE `forward_annotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` text NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `strategy_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `forward_annotations_version_idx` ON `forward_annotations` (`version_id`,`date`);--> statement-breakpoint
CREATE TABLE `forward_entries` (
	`version_id` text NOT NULL,
	`date` text NOT NULL,
	`payload` text NOT NULL,
	`allocation` text NOT NULL,
	`holdings` text NOT NULL,
	`safe_state_applied` integer NOT NULL,
	`data_status` text NOT NULL,
	`equity` real,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`version_id`, `date`),
	FOREIGN KEY (`version_id`) REFERENCES `strategy_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forward_entries_status_check" CHECK("forward_entries"."data_status" IN ('green', 'yellow', 'red'))
);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`version_id` text NOT NULL,
	`signal_date` text NOT NULL,
	`action` text NOT NULL,
	`action_date` text,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `strategy_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "journal_entries_action_check" CHECK("journal_entries"."action" IN ('done', 'skipped', 'delayed'))
);
--> statement-breakpoint
CREATE INDEX `journal_entries_owner_idx` ON `journal_entries` (`owner_id`,`version_id`);--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`definition` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `strategies_owner_idx` ON `strategies` (`owner_id`);--> statement-breakpoint
CREATE TABLE `strategy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`strategy_id` text,
	`name` text NOT NULL,
	`canonical_json` text NOT NULL,
	`registered_at` text NOT NULL,
	`hash` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `strategy_versions_owner_idx` ON `strategy_versions` (`owner_id`);
--> statement-breakpoint
CREATE TRIGGER `strategy_versions_no_update` BEFORE UPDATE ON `strategy_versions`
BEGIN
  SELECT RAISE(ABORT, 'strategy_versions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `strategy_versions_no_delete` BEFORE DELETE ON `strategy_versions`
BEGIN
  SELECT RAISE(ABORT, 'strategy_versions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `forward_entries_no_update` BEFORE UPDATE ON `forward_entries`
BEGIN
  SELECT RAISE(ABORT, 'forward_entries is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `forward_entries_no_delete` BEFORE DELETE ON `forward_entries`
BEGIN
  SELECT RAISE(ABORT, 'forward_entries is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `forward_annotations_no_update` BEFORE UPDATE ON `forward_annotations`
BEGIN
  SELECT RAISE(ABORT, 'forward_annotations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `forward_annotations_no_delete` BEFORE DELETE ON `forward_annotations`
BEGIN
  SELECT RAISE(ABORT, 'forward_annotations is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `chain_anchors_no_update` BEFORE UPDATE ON `chain_anchors`
BEGIN
  SELECT RAISE(ABORT, 'chain_anchors is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `chain_anchors_no_delete` BEFORE DELETE ON `chain_anchors`
BEGIN
  SELECT RAISE(ABORT, 'chain_anchors is append-only');
END;
