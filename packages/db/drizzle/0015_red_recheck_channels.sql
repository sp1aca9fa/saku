ALTER TABLE `red_rechecks` ADD `provisional_channels` integer;--> statement-breakpoint
ALTER TABLE `red_rechecks` ADD `final_channels` integer;--> statement-breakpoint
-- Requirements 04 "Red re-check before execution" (C16 review): a re-check is marked as told with
-- the number of channels its message reached; a sending time is recorded only when it reached at
-- least one (0: a library version or an owner with no channel, nothing sent). The set-once rule of
-- 0014 is replaced by the same rule with the two new columns (also set once).
DROP TRIGGER `red_rechecks_set_once`;
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
  OR (OLD.provisional_channels IS NOT NULL AND NEW.provisional_channels IS NOT OLD.provisional_channels)
  OR (OLD.final_at IS NOT NULL AND NEW.final_at IS NOT OLD.final_at)
  OR (OLD.final_run_id IS NOT NULL AND NEW.final_run_id IS NOT OLD.final_run_id)
  OR (OLD.outcome IS NOT NULL AND NEW.outcome IS NOT OLD.outcome)
  OR (OLD.final_sent_at IS NOT NULL AND NEW.final_sent_at IS NOT OLD.final_sent_at)
  OR (OLD.final_channels IS NOT NULL AND NEW.final_channels IS NOT OLD.final_channels)
BEGIN
  SELECT RAISE(ABORT, 'red_rechecks: a recorded value is never changed');
END;
--> statement-breakpoint
CREATE TRIGGER `red_rechecks_told` BEFORE UPDATE ON `red_rechecks`
WHEN NEW.provisional_channels < 0
  OR NEW.final_channels < 0
  OR (NEW.provisional_channels IS NOT NULL AND (NEW.provisional_channels > 0) IS NOT (NEW.provisional_sent_at IS NOT NULL))
  OR (NEW.final_channels IS NOT NULL AND (NEW.final_channels > 0) IS NOT (NEW.final_sent_at IS NOT NULL))
  OR (OLD.provisional_sent_at IS NULL AND NEW.provisional_sent_at IS NOT NULL AND NEW.provisional_channels IS NULL)
  OR (OLD.final_sent_at IS NULL AND NEW.final_sent_at IS NOT NULL AND NEW.final_channels IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'red_rechecks: a sending time goes with the channels the message reached');
END;
