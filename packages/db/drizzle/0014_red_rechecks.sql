CREATE TABLE `red_rechecks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` text NOT NULL,
	`date` text NOT NULL,
	`first_red_at` text NOT NULL,
	`first_run_id` text,
	`reasons` text NOT NULL,
	`deadline` text NOT NULL,
	`provisional` text NOT NULL,
	`provisional_sent_at` text,
	`final_at` text,
	`final_run_id` text,
	`outcome` text,
	`final_sent_at` text,
	FOREIGN KEY (`version_id`) REFERENCES `strategy_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`first_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`final_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "red_rechecks_outcome_check" CHECK("red_rechecks"."outcome" IS NULL OR "red_rechecks"."outcome" IN ('cleared', 'safe_state', 'late', 'not_rechecked')),
	CONSTRAINT "red_rechecks_final_check" CHECK(("red_rechecks"."outcome" IS NULL) = ("red_rechecks"."final_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `red_rechecks_key_idx` ON `red_rechecks` (`version_id`,`date`);--> statement-breakpoint
ALTER TABLE `job_runs` ADD `recheck` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Requirements 04 "Red re-check before execution" (decisions log 2026-11-01, C16): a re-check row
-- is never deleted, what it recorded at the first red grading never changes, and each later column
-- (the sending times, the final time, run and outcome) is set once, never overwritten.
CREATE TRIGGER `red_rechecks_no_delete` BEFORE DELETE ON `red_rechecks`
BEGIN
  SELECT RAISE(ABORT, 'red_rechecks rows are kept');
END;
--> statement-breakpoint
CREATE TRIGGER `red_rechecks_set_once` BEFORE UPDATE ON `red_rechecks`
WHEN NEW.id IS NOT OLD.id
  OR NEW.version_id IS NOT OLD.version_id
  OR NEW.date IS NOT OLD.date
  OR NEW.first_red_at IS NOT OLD.first_red_at
  OR NEW.first_run_id IS NOT OLD.first_run_id
  OR NEW.reasons IS NOT OLD.reasons
  OR NEW.deadline IS NOT OLD.deadline
  OR NEW.provisional IS NOT OLD.provisional
  OR (OLD.provisional_sent_at IS NOT NULL AND NEW.provisional_sent_at IS NOT OLD.provisional_sent_at)
  OR (OLD.final_at IS NOT NULL AND NEW.final_at IS NOT OLD.final_at)
  OR (OLD.final_run_id IS NOT NULL AND NEW.final_run_id IS NOT OLD.final_run_id)
  OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
  OR (OLD.final_sent_at IS NOT NULL AND NEW.final_sent_at IS NOT OLD.final_sent_at)
BEGIN
  SELECT RAISE(ABORT, 'red_rechecks: a recorded value is never changed');
END;
