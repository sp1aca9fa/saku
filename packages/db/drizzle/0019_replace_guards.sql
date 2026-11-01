-- INSERT OR REPLACE (and REPLACE INTO) resolves a key conflict by deleting the old row, and that
-- delete fires no DELETE trigger (recursive triggers are off), so it would remove or move a row
-- the no-delete and set-once triggers protect. These BEFORE INSERT guards refuse any insert whose
-- key already exists, so no conflict can be reached (data rules: stored data is never silently
-- overwritten; forward records are append-only). Plain inserts of a new key are unaffected; the
-- application never upserts into these tables. `stand_ins` is not guarded: the verify run
-- upserts open stand-ins by key (ON CONFLICT DO UPDATE fires BEFORE INSERT triggers too).
CREATE TRIGGER `user_tax_accounts_no_replace` BEFORE INSERT ON `user_tax_accounts`
WHEN EXISTS (SELECT 1 FROM `user_tax_accounts` WHERE `id` = NEW.id)
  OR (NEW.closed_on IS NULL AND EXISTS (
    SELECT 1 FROM `user_tax_accounts`
    WHERE `owner_id` = NEW.owner_id AND `account_type` = NEW.account_type AND `closed_on` IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'user_tax_accounts: a row with this key exists and is kept');
END;
--> statement-breakpoint
CREATE TRIGGER `stand_in_closes_no_replace` BEFORE INSERT ON `stand_in_closes`
WHEN EXISTS (SELECT 1 FROM `stand_in_closes` WHERE `id` = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'stand_in_closes: a row with this key exists and is kept');
END;
--> statement-breakpoint
CREATE TRIGGER `closed_event_resolutions_no_replace` BEFORE INSERT ON `closed_event_resolutions`
WHEN EXISTS (SELECT 1 FROM `closed_event_resolutions` WHERE `id` = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'closed_event_resolutions: a row with this key exists and is kept');
END;
--> statement-breakpoint
CREATE TRIGGER `red_rechecks_no_replace` BEFORE INSERT ON `red_rechecks`
WHEN EXISTS (SELECT 1 FROM `red_rechecks` WHERE `id` = NEW.id)
  OR EXISTS (SELECT 1 FROM `red_rechecks` WHERE `version_id` = NEW.version_id AND `date` = NEW.date)
BEGIN
  SELECT RAISE(ABORT, 'red_rechecks: a row with this key exists and is kept');
END;
--> statement-breakpoint
CREATE TRIGGER `strategy_versions_no_replace` BEFORE INSERT ON `strategy_versions`
WHEN EXISTS (SELECT 1 FROM `strategy_versions` WHERE `id` = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'strategy_versions: a row with this key exists and is kept');
END;
--> statement-breakpoint
CREATE TRIGGER `forward_entries_no_replace` BEFORE INSERT ON `forward_entries`
WHEN EXISTS (SELECT 1 FROM `forward_entries` WHERE `version_id` = NEW.version_id AND `date` = NEW.date)
BEGIN
  SELECT RAISE(ABORT, 'forward_entries: a row with this key exists and is kept');
END;
--> statement-breakpoint
CREATE TRIGGER `forward_annotations_no_replace` BEFORE INSERT ON `forward_annotations`
WHEN EXISTS (SELECT 1 FROM `forward_annotations` WHERE `id` = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'forward_annotations: a row with this key exists and is kept');
END;
--> statement-breakpoint
CREATE TRIGGER `chain_anchors_no_replace` BEFORE INSERT ON `chain_anchors`
WHEN EXISTS (SELECT 1 FROM `chain_anchors` WHERE `id` = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'chain_anchors: a row with this key exists and is kept');
END;
