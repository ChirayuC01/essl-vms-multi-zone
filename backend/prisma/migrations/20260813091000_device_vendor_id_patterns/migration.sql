-- Which user IDs on a given terminal are vendors, as case-insensitive globs.
--
-- Replaces VENDOR_PIN_START/END, which was a single global numeric range and
-- therefore could not describe a roster of `WCTPL070`s at all. Empty means
-- everything on this device is ours -- the right default for a vendor-only
-- terminal, and what every existing install gets.
ALTER TABLE "device" ADD COLUMN "vendor_id_patterns" TEXT[] NOT NULL DEFAULT '{}';
