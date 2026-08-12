-- 0006_x_posts_chart.sql — sparkline data for X Search feed (PR #8)
-- Additive migration. Adds optional chart data (recent daily closes) so the
-- frontend can render a self-hosted sparkline instead of third-party widgets.
ALTER TABLE x_posts ADD COLUMN chart_json TEXT;
ALTER TABLE x_posts ADD COLUMN price TEXT;
ALTER TABLE x_posts ADD COLUMN change TEXT;
