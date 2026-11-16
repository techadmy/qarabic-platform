-- D151 (b): the Zoom account's licensed users, synced into the host pool.
ALTER TABLE "zoom_hosts" ADD COLUMN "display_name" VARCHAR(255),
ADD COLUMN "join_url" TEXT,
ADD COLUMN "license_type" VARCHAR(20),
ADD COLUMN "last_synced_at" TIMESTAMPTZ(6);
