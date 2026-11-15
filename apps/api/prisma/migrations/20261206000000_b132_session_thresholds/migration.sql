-- B132 (D148, Ahmed 2026-11-15): a teacher is late after 5 minutes. A stored value from before the
-- decision is replaced; the new Zoom thresholds use their code defaults (10, 10, 80 %).
UPDATE "app_settings" SET "value" = '5'::jsonb, "updated_at" = CURRENT_TIMESTAMP
 WHERE "key" = 'sessions.late_teacher_min' AND "value" <> '5'::jsonb;
