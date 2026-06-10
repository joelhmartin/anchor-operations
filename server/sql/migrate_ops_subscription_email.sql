-- Phase 6 — Operations rebuild: per-subscription email_on_completion flag.
--
-- Adds a single boolean column to client_run_subscriptions controlling whether
-- the email digest service fires after a run completes for that subscription.
--
-- Idempotent.

ALTER TABLE client_run_subscriptions
  ADD COLUMN IF NOT EXISTS email_on_completion BOOLEAN NOT NULL DEFAULT FALSE;
