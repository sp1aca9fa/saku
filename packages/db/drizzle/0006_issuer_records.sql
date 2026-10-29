CREATE TABLE `issuer_records` (
	`symbol_id` integer NOT NULL,
	`source` text NOT NULL,
	`date` text NOT NULL,
	`nav` real,
	`distribution` real,
	`split` real,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`symbol_id`, `source`, `date`, `fetched_at`),
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action
);
