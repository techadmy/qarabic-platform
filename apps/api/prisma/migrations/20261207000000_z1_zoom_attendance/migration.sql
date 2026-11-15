-- Z1 (docs/42 §6, D148): Zoom attendance via a Server-to-Server app and webhooks (off until the
-- owner sets the ZOOM_* keys). The teacher's PMI on their dedicated host, and the event log.
ALTER TABLE "zoom_hosts" ADD COLUMN "pmi_meeting_id" VARCHAR(20);
CREATE UNIQUE INDEX "zoom_hosts_pmi_meeting_id_key" ON "zoom_hosts"("pmi_meeting_id");

CREATE TABLE "zoom_webhook_events" (
    "id" SERIAL NOT NULL,
    "event_key" CHAR(64) NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'webhook',
    "meeting_id" VARCHAR(32),
    "meeting_uuid" VARCHAR(128),
    "host_id" VARCHAR(64),
    "payload" JSONB NOT NULL,
    "event_at" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'received',
    "session_id" INTEGER,
    "error" VARCHAR(500),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "reconciled_at" TIMESTAMPTZ(6),

    CONSTRAINT "zoom_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zoom_webhook_events_event_key_key" ON "zoom_webhook_events"("event_key");
CREATE INDEX "zoom_webhook_events_status_received_at_idx" ON "zoom_webhook_events"("status", "received_at");
CREATE INDEX "zoom_webhook_events_session_id_idx" ON "zoom_webhook_events"("session_id");
CREATE INDEX "zoom_webhook_events_event_reconciled_at_idx" ON "zoom_webhook_events"("event", "reconciled_at");
