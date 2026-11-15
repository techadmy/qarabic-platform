-- D1 (docs/40): indexes for the dashboard aggregates.
CREATE INDEX "leads_converted_at_idx" ON "leads"("converted_at");
CREATE INDEX "invoices_issue_date_idx" ON "invoices"("issue_date");
CREATE INDEX "enrollments_kind_student_id_starts_on_idx" ON "enrollments"("kind", "student_id", "starts_on");
