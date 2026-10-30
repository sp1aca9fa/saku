CREATE TABLE `series_spans` (
	`series` text NOT NULL,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL,
	`first_date` text NOT NULL,
	`last_date` text NOT NULL,
	PRIMARY KEY(`series`, `source`, `fetched_at`)
);
