-- D153: permanent demo logins (teacher, parent) for manual testing on production.
ALTER TABLE "users" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;
