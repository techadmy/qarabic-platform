-- Z1 security review follow-ups: retries with backoff, stuck-row reclaim, and the indexes the
-- teacher-presence replay uses.
ALTER TABLE "zoom_webhook_events" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "zoom_webhook_events" ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6);
ALTER TABLE "zoom_webhook_events" ADD COLUMN "claimed_at" TIMESTAMPTZ(6);

CREATE INDEX "zoom_webhook_events_meeting_id_event_at_idx" ON "zoom_webhook_events"("meeting_id", "event_at");
CREATE INDEX "zoom_webhook_events_host_id_event_at_idx" ON "zoom_webhook_events"("host_id", "event_at");
