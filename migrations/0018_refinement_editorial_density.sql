-- 0018: refinement editorial density.
--
-- The built-in prompt now targets roughly 75–85% of the raw transcript by editing verbal
-- redundancy while preserving independent information and reasoning. The runtime completeness
-- guard is a safety floor rather than the editing target.
--
-- Treat the exact historical 0.90 value as the old default. Other values are considered custom
-- deployment choices and are preserved.
UPDATE refiner_settings
SET min_output_ratio = 0.70,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1
  AND min_output_ratio = 0.90;
