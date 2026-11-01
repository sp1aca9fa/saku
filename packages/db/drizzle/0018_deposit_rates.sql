CREATE TABLE `deposit_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rate_pct` text NOT NULL,
	`from_date` text NOT NULL,
	`currency` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deposit_rates_from_uq` ON `deposit_rates` (`from_date`);--> statement-breakpoint
-- Requirements 05 `CASH_BASE`, 01 "Bank deposits"; CLAUDE.md: rates are read only through asOf.
-- The deposit rate series is append-only: an entry is never edited or removed, and a new one
-- starts after every earlier one, so what a past date reads never changes.
CREATE TRIGGER `deposit_rates_in_order` BEFORE INSERT ON `deposit_rates`
WHEN EXISTS (SELECT 1 FROM `deposit_rates` WHERE `from_date` >= NEW.`from_date`)
BEGIN
  SELECT RAISE(ABORT, 'a deposit rate entry starts after every earlier one');
END;
--> statement-breakpoint
CREATE TRIGGER `deposit_rates_no_update` BEFORE UPDATE ON `deposit_rates`
BEGIN
  SELECT RAISE(ABORT, 'deposit_rates is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `deposit_rates_no_delete` BEFORE DELETE ON `deposit_rates`
BEGIN
  SELECT RAISE(ABORT, 'deposit_rates is append-only');
END;
