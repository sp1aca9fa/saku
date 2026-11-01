CREATE TABLE `deposit_rate_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`old_rate_pct` text NOT NULL,
	`new_rate_pct` text NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `deposit_rates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deposit_rate_revisions_entry_idx` ON `deposit_rate_revisions` (`entry_id`);--> statement-breakpoint
-- Deposit rates: a backfill before the earliest entry is allowed (every reader saw unknown there);
-- an entry on or between existing dates is still refused (it would change what a date already
-- read). Replaces 0018's rule (each entry after every earlier one).
DROP TRIGGER `deposit_rates_in_order`;
--> statement-breakpoint
CREATE TRIGGER `deposit_rates_in_order` BEFORE INSERT ON `deposit_rates`
WHEN EXISTS (SELECT 1 FROM `deposit_rates` WHERE `from_date` >= NEW.`from_date`)
  AND EXISTS (SELECT 1 FROM `deposit_rates` WHERE `from_date` <= NEW.`from_date`)
BEGIN
  SELECT RAISE(ABORT, 'a deposit rate entry starts after the latest or before the earliest');
END;
--> statement-breakpoint
-- REPLACE guard (as 0019): INSERT OR REPLACE on an existing id would delete the old row without
-- firing the no-delete trigger.
CREATE TRIGGER `deposit_rates_no_replace` BEFORE INSERT ON `deposit_rates`
WHEN EXISTS (SELECT 1 FROM `deposit_rates` WHERE `id` = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'deposit_rates: a row with this key exists and is kept');
END;
--> statement-breakpoint
-- Corrections (the revision log): each names a reason, and replaces the rate in force for its
-- entry (the latest correction's, or the entry's own), so the chain of values is complete.
CREATE TRIGGER `deposit_rate_revisions_checked` BEFORE INSERT ON `deposit_rate_revisions`
WHEN trim(NEW.reason) = ''
  OR NOT EXISTS (SELECT 1 FROM `deposit_rates` WHERE `id` = NEW.entry_id)
  OR NEW.old_rate_pct IS NOT COALESCE(
    (SELECT `new_rate_pct` FROM `deposit_rate_revisions`
     WHERE `entry_id` = NEW.entry_id ORDER BY `id` DESC LIMIT 1),
    (SELECT `rate_pct` FROM `deposit_rates` WHERE `id` = NEW.entry_id))
BEGIN
  SELECT RAISE(ABORT, 'a deposit rate correction names its entry, the rate in force and a reason');
END;
--> statement-breakpoint
CREATE TRIGGER `deposit_rate_revisions_no_replace` BEFORE INSERT ON `deposit_rate_revisions`
WHEN EXISTS (SELECT 1 FROM `deposit_rate_revisions` WHERE `id` = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'deposit_rate_revisions: a row with this key exists and is kept');
END;
--> statement-breakpoint
CREATE TRIGGER `deposit_rate_revisions_no_update` BEFORE UPDATE ON `deposit_rate_revisions`
BEGIN
  SELECT RAISE(ABORT, 'deposit_rate_revisions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `deposit_rate_revisions_no_delete` BEFORE DELETE ON `deposit_rate_revisions`
BEGIN
  SELECT RAISE(ABORT, 'deposit_rate_revisions is append-only');
END;
