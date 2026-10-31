CREATE TABLE `stand_in_closes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol_id` integer NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`close` real NOT NULL,
	`band` real NOT NULL,
	`basis` text NOT NULL,
	`closed_by` text NOT NULL,
	`reason` text NOT NULL,
	`closed_at` text NOT NULL,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stand_in_closes_key_idx` ON `stand_in_closes` (`symbol_id`,`date`);--> statement-breakpoint
ALTER TABLE `bars` ADD `stand_in_band` real;--> statement-breakpoint
ALTER TABLE `bars` ADD `stand_in_basis` text;--> statement-breakpoint
-- Requirements 04 stand-in rule 5: every close is kept as it was made (append-only), with its
-- admin and a reason.
CREATE TRIGGER `stand_in_closes_needs_reason` BEFORE INSERT ON `stand_in_closes`
WHEN trim(NEW.reason) = ''
BEGIN
  SELECT RAISE(ABORT, 'a stand-in is closed with an admin and a reason');
END;
--> statement-breakpoint
CREATE TRIGGER `stand_in_closes_no_update` BEFORE UPDATE ON `stand_in_closes`
BEGIN
  SELECT RAISE(ABORT, 'stand_in_closes is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `stand_in_closes_no_delete` BEFORE DELETE ON `stand_in_closes`
BEGIN
  SELECT RAISE(ABORT, 'stand_in_closes is append-only');
END;
