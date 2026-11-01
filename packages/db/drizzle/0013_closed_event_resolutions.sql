CREATE TABLE `closed_event_resolutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol_id` integer NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`div_cash` real NOT NULL,
	`split_factor` real NOT NULL,
	`resolved_by` text NOT NULL,
	`reason` text NOT NULL,
	`resolved_at` text NOT NULL,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `closed_event_resolutions_key_idx` ON `closed_event_resolutions` (`symbol_id`,`date`);--> statement-breakpoint
-- Requirements 04 "Closed-day bars", decisions log 2026-11-01, C19: every resolution is kept as
-- it was made (append-only), with its admin and a reason.
CREATE TRIGGER `closed_event_resolutions_needs_reason` BEFORE INSERT ON `closed_event_resolutions`
WHEN trim(NEW.reason) = ''
BEGIN
  SELECT RAISE(ABORT, 'a closed-day event is resolved with an admin and a reason');
END;
--> statement-breakpoint
CREATE TRIGGER `closed_event_resolutions_no_update` BEFORE UPDATE ON `closed_event_resolutions`
BEGIN
  SELECT RAISE(ABORT, 'closed_event_resolutions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `closed_event_resolutions_no_delete` BEFORE DELETE ON `closed_event_resolutions`
BEGIN
  SELECT RAISE(ABORT, 'closed_event_resolutions is append-only');
END;
