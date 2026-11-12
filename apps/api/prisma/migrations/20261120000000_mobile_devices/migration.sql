-- Mobile readiness (docs/17 §5): push device tokens and the push channel preference.

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ios', 'android', 'web');

-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "push" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token" VARCHAR(512) NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "app_version" VARCHAR(32),
    "device_name" VARCHAR(80),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

