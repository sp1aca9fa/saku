ALTER TABLE `stand_ins` ADD `closed_at` text;--> statement-breakpoint
ALTER TABLE `stand_ins` ADD `closed_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `stand_ins` ADD `close_reason` text;--> statement-breakpoint
-- Requirements 04 stand-in rule 5: a close is recorded once, with its admin and reason, and the
-- closed stand-in's values stay as they were (a primary arriving later still resolves it).
CREATE TRIGGER `stand_ins_close_needs_reason` BEFORE INSERT ON `stand_ins`
WHEN NEW.closed_at IS NOT NULL AND (NEW.closed_by IS NULL OR NEW.close_reason IS NULL OR trim(NEW.close_reason) = '')
BEGIN
  SELECT RAISE(ABORT, 'a stand-in is closed with an admin and a reason');
END;
--> statement-breakpoint
CREATE TRIGGER `stand_ins_close_needs_reason_update` BEFORE UPDATE ON `stand_ins`
WHEN NEW.closed_at IS NOT NULL AND (NEW.closed_by IS NULL OR NEW.close_reason IS NULL OR trim(NEW.close_reason) = '')
BEGIN
  SELECT RAISE(ABORT, 'a stand-in is closed with an admin and a reason');
END;
--> statement-breakpoint
CREATE TRIGGER `stand_ins_closed_frozen` BEFORE UPDATE ON `stand_ins`
WHEN OLD.closed_at IS NOT NULL AND (
  NEW.closed_at IS NOT OLD.closed_at OR NEW.closed_by IS NOT OLD.closed_by
  OR NEW.close_reason IS NOT OLD.close_reason OR NEW.symbol_id IS NOT OLD.symbol_id
  OR NEW.date IS NOT OLD.date OR NEW.source IS NOT OLD.source OR NEW.close IS NOT OLD.close
  OR NEW.band IS NOT OLD.band OR NEW.basis IS NOT OLD.basis OR NEW.run_id IS NOT OLD.run_id
  OR NEW.created_at IS NOT OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'a closed stand-in is not changed');
END;
--> statement-breakpoint
CREATE TRIGGER `stand_ins_closed_no_delete` BEFORE DELETE ON `stand_ins`
WHEN OLD.closed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a closed stand-in is not deleted');
END;
