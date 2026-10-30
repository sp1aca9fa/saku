CREATE TABLE `fx_withdrawals` (
	`pair` text NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`published_at` text,
	`fetched_at` text NOT NULL,
	`known_at` text NOT NULL,
	PRIMARY KEY(`pair`, `kind`, `date`, `source`, `known_at`, `fetched_at`),
	CONSTRAINT "fx_withdrawals_kind_check" CHECK("fx_withdrawals"."kind" IN ('valuation', 'tax_mid', 'tax_buy', 'tax_sell'))
);
--> statement-breakpoint
CREATE TABLE `series_withdrawals` (
	`series` text NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`published_at` text,
	`fetched_at` text NOT NULL,
	`known_at` text NOT NULL,
	PRIMARY KEY(`series`, `date`, `source`, `known_at`, `fetched_at`)
);
