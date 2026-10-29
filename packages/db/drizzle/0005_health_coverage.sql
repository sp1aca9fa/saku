CREATE TABLE `health_coverage` (
	`run_id` text NOT NULL,
	`symbol_id` integer NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	PRIMARY KEY(`run_id`, `symbol_id`),
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`symbol_id`) REFERENCES `symbols`(`id`) ON UPDATE no action ON DELETE no action
);
