-- One-time ops-activity wipe (admin only; ops_app cannot DELETE all rows).
-- Activity tables only; config preserved. social_* are commented out by default —
-- uncomment ONLY after confirming social_posts holds no production rows.
-- Usage: psql "$ADMIN_DATABASE_URL" -f infra/sql/wipe_ops_activity.sql
BEGIN;
DELETE FROM ops_chat_messages;
DELETE FROM ops_chat_threads;
DELETE FROM ops_tool_approvals;
DELETE FROM ops_bulk_runs;
DELETE FROM ops_blog_posts;
DELETE FROM ops_reports;
DELETE FROM ops_findings;
DELETE FROM ops_check_results;
DELETE FROM ops_runs;
DELETE FROM kinsta_ssh_command_log;
DELETE FROM kinsta_findings;
-- DELETE FROM social_media_tokens;
-- DELETE FROM social_posts;
COMMIT;
