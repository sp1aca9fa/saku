CREATE TABLE `stand_ins` (
	`symbol_id` integer NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`close` real NOT NULL,
	`band` real NOT NULL,
	`basis` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	`primary_close` real,
	`deviation` real,
	`resolved_at` text,
	`resolved_run_id` text,
	PRIMARY KEY(`symbol_id`, `date`),
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action
);
