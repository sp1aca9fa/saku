CREATE TABLE `user_tax_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_type` text NOT NULL,
	`opened_on` text,
	`created_at` text NOT NULL,
	`closed_on` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_tax_accounts_type_check" CHECK("user_tax_accounts"."account_type" <> 'taxable'),
	CONSTRAINT "user_tax_accounts_dates_check" CHECK("user_tax_accounts"."opened_on" IS NULL OR "user_tax_accounts"."closed_on" IS NULL OR "user_tax_accounts"."closed_on" >= "user_tax_accounts"."opened_on")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_tax_accounts_open_uq` ON `user_tax_accounts` (`owner_id`,`account_type`) WHERE "user_tax_accounts"."closed_on" IS NULL;--> statement-breakpoint
CREATE INDEX `user_tax_accounts_owner_idx` ON `user_tax_accounts` (`owner_id`);--> statement-breakpoint
-- Requirements 07 "Model" (per-user tax accounts) and the data rules (stored data is never
-- silently overwritten): a tax account row is never deleted, and only `closed_on` is ever set,
-- once (a reopened account is a new row).
CREATE TRIGGER `user_tax_accounts_no_delete` BEFORE DELETE ON `user_tax_accounts`
BEGIN
  SELECT RAISE(ABORT, 'user_tax_accounts rows are kept');
END;
--> statement-breakpoint
CREATE TRIGGER `user_tax_accounts_close_once` BEFORE UPDATE ON `user_tax_accounts`
WHEN NEW.id IS NOT OLD.id
  OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.account_type IS NOT OLD.account_type
  OR NEW.opened_on IS NOT OLD.opened_on
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.closed_on IS NOT NULL
  OR NEW.closed_on IS NULL
BEGIN
  SELECT RAISE(ABORT, 'user_tax_accounts: only closed_on is set, once');
END;
