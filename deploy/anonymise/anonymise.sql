-- Anonymise a restored copy of the Laravel MySQL database (docs/37 §6 F6).
-- Run ONLY by deploy/anonymise/anonymise-mysql-dump.sh on a throwaway local database
-- (`*_anon`): it refuses any other target. Kept: every id, foreign key, status, date/time,
-- money amount, currency, time zone and count. Replaced: names, emails, phones, addresses,
-- free text (notes, messages, reports, reasons), meeting links, IPs, user agents, tokens,
-- passwords (one known rehearsal password), and name/email/phone keys inside JSON blobs.
--
-- Set by the wrapper: @enc_url, @enc_phone (Laravel `encrypted` payloads of fake values under
-- the fake ANON_APP_KEY) and @pw (bcrypt of the rehearsal password).
-- Blocks start with `-- @table <name>`; the wrapper skips a block whose table is missing.

-- @table _setup
SET @dom = 'anon.qarabic.test';
SET SESSION sql_safe_updates = 0;
SET FOREIGN_KEY_CHECKS = 0;

-- @table users
UPDATE users SET
  name = CONCAT(ELT(1 + id % 16, 'Ahmad', 'Yusuf', 'Omar', 'Khalid', 'Hamza', 'Bilal', 'Zaid',
    'Ibrahim', 'Maryam', 'Aisha', 'Fatima', 'Khadija', 'Sara', 'Huda', 'Amina', 'Zainab'), ' ',
    ELT(1 + (id DIV 16) % 12, 'Hassan', 'Ali', 'Mahmoud', 'Saleh', 'Nasser', 'Kareem', 'Rahman',
    'Haddad', 'Farouk', 'Yasin', 'Mansour', 'Qasim'), ' ', id),
  email = CONCAT('user', id, '@', @dom),
  phone = CONCAT('+1555', LPAD(id, 7, '0')),
  image = NULL,
  remember_token = NULL,
  password = @pw,
  archive_reason = IF(archive_reason IS NULL OR archive_reason = '', archive_reason, CONCAT('Anonymised reason #', id));

-- @table teachers
UPDATE teachers SET
  f_name = IF(f_name IS NULL, NULL, ELT(1 + id % 8, 'Ahmad', 'Yusuf', 'Omar', 'Maryam', 'Aisha', 'Fatima', 'Huda', 'Amina')),
  l_name = IF(l_name IS NULL, NULL, CONCAT('Teacher', id)),
  image = NULL, cv = NULL, nic_number = NULL, skype_id = NULL, marital_status = NULL,
  alt_phone = IF(alt_phone IS NULL OR alt_phone = '', alt_phone, CONCAT('+1556', LPAD(id, 7, '0'))),
  address = IF(address IS NULL OR address = '', address, CONCAT('Address ', id)),
  qualification = IF(qualification IS NULL OR qualification = '', qualification, 'Ijazah (anonymised)'),
  experience = IF(experience IS NULL OR experience = '', experience, 'Experience (anonymised)'),
  description = IF(description IS NULL OR description = '', description, CONCAT('Anonymised profile #', id)),
  status_reason = IF(status_reason IS NULL OR status_reason = '', status_reason, CONCAT('Anonymised reason #', id)),
  archive_reason = IF(archive_reason IS NULL OR archive_reason = '', archive_reason, CONCAT('Anonymised reason #', id));

-- @table families
UPDATE families SET
  email = IF(email IS NULL OR email = '', email, CONCAT('family', id, '@', @dom)),
  mobile = IF(mobile IS NULL OR mobile = '', mobile, CONCAT('+1557', LPAD(id, 7, '0'))),
  telephone = IF(telephone IS NULL OR telephone = '', telephone, CONCAT('+1558', LPAD(id, 7, '0'))),
  zoom_id = IF(zoom_id IS NULL OR zoom_id = '', zoom_id, CONCAT('zoom-family-', id)),
  comment = IF(comment IS NULL OR comment = '', comment, CONCAT('Anonymised comment #', id)),
  notes = IF(notes IS NULL OR notes = '', notes, CONCAT('Anonymised notes #', id)),
  status_reason = IF(status_reason IS NULL OR status_reason = '', status_reason, CONCAT('Anonymised reason #', id)),
  archive_reason = IF(archive_reason IS NULL OR archive_reason = '', archive_reason, CONCAT('Anonymised reason #', id));

-- @table students
UPDATE students SET
  name = CONCAT(ELT(1 + id % 12, 'Adam', 'Yahya', 'Musa', 'Isa', 'Nuh', 'Idris', 'Layla', 'Noor',
    'Safiya', 'Hafsa', 'Ruqayya', 'Sumayya'), ' ', id),
  email = IF(email IS NULL OR email = '', email, CONCAT('student', id, '@', @dom)),
  zoom_id = IF(zoom_id IS NULL OR zoom_id = '', zoom_id, CONCAT('zoom-student-', id)),
  remark_parent = IF(remark_parent IS NULL OR remark_parent = '', remark_parent, CONCAT('Anonymised remark #', id)),
  remark_teacher = IF(remark_teacher IS NULL OR remark_teacher = '', remark_teacher, CONCAT('Anonymised remark #', id)),
  status_reason = IF(status_reason IS NULL OR status_reason = '', status_reason, CONCAT('Anonymised reason #', id)),
  archive_reason = IF(archive_reason IS NULL OR archive_reason = '', archive_reason, CONCAT('Anonymised reason #', id));

-- @table class_requests
UPDATE class_requests SET
  name = IF(name IS NULL, NULL, CONCAT('Requester ', id)),
  email = IF(email IS NULL OR email = '', email, CONCAT('request', id, '@', @dom)),
  phone = IF(phone IS NULL OR phone = '', phone, CONCAT('+1559', LPAD(id, 7, '0'))),
  notes = IF(notes IS NULL OR notes = '', notes, CONCAT('Anonymised notes #', id)),
  referral_id = NULL;

-- @table classes
UPDATE classes SET
  teacher_note = IF(teacher_note IS NULL OR teacher_note = '', teacher_note, CONCAT('Anonymised note #', id)),
  zoom_join_url = IF(zoom_join_url IS NULL OR zoom_join_url = '', zoom_join_url, @enc_url);

-- @table enrollments
UPDATE enrollments SET
  external_meeting_url = IF(external_meeting_url IS NULL OR external_meeting_url = '', external_meeting_url, @enc_url),
  notes = IF(notes IS NULL OR notes = '', notes, CONCAT('Anonymised notes #', id));

-- @table courses
UPDATE courses SET zoom_link = IF(zoom_link IS NULL OR zoom_link = '', zoom_link, 'https://meet.example.test/anon');

-- @table leads
UPDATE leads SET
  parent_name = CONCAT('Lead parent ', id),
  email = IF(email IS NULL OR email = '', email, CONCAT('lead', id, '@', @dom)),
  phone = IF(phone IS NULL OR phone = '', phone, CONCAT('+1560', LPAD(id, 7, '0'))),
  phone_digits = IF(phone_digits IS NULL OR phone_digits = '', phone_digits, CONCAT('1560', LPAD(id, 7, '0'))),
  city = IF(city IS NULL OR city = '', city, 'City'),
  message = IF(message IS NULL OR message = '', message, CONCAT('Anonymised message #', id)),
  status_note = IF(status_note IS NULL OR status_note = '', status_note, CONCAT('Anonymised note #', id)),
  ip_hash = IF(ip_hash IS NULL, NULL, SHA2(CONCAT('anon-ip-', id), 256));

-- @table lead_activities
UPDATE lead_activities SET body = IF(body IS NULL OR body = '', body, CONCAT('Anonymised activity #', id));

-- @table lesson_reports
UPDATE lesson_reports SET
  summary = CONCAT('Anonymised lesson summary #', id),
  teacher_notes = IF(teacher_notes IS NULL OR teacher_notes = '', teacher_notes, CONCAT('Anonymised notes #', id)),
  homework = IF(homework IS NULL OR homework = '', homework, CONCAT('Anonymised homework #', id));

-- @table hifz_entries
UPDATE hifz_entries SET notes = IF(notes IS NULL OR notes = '', notes, CONCAT('Anonymised notes #', id));

-- @table student_tests
UPDATE student_tests SET
  notes = IF(notes IS NULL OR notes = '', notes, CONCAT('Anonymised notes #', id)),
  remarks = IF(remarks IS NULL OR remarks = '', remarks, CONCAT('Anonymised remarks #', id)),
  internal_notes = IF(internal_notes IS NULL OR internal_notes = '', internal_notes, CONCAT('Anonymised notes #', id)),
  status_reason = IF(status_reason IS NULL OR status_reason = '', status_reason, CONCAT('Anonymised reason #', id));

-- @table session_requests
UPDATE session_requests SET
  reason = IF(reason IS NULL OR reason = '', reason, CONCAT('Anonymised reason #', id)),
  decision_note = IF(decision_note IS NULL OR decision_note = '', decision_note, CONCAT('Anonymised note #', id));

-- @table feedback_tickets
UPDATE feedback_tickets SET
  title = CONCAT('Anonymised ticket #', id),
  description = IF(description IS NULL OR description = '', description, CONCAT('Anonymised description #', id)),
  resolution = IF(resolution IS NULL OR resolution = '', resolution, CONCAT('Anonymised resolution #', id)),
  contact_phone = IF(contact_phone IS NULL OR contact_phone = '', contact_phone, @enc_phone),
  contact_hash = IF(contact_hash IS NULL, NULL, SHA2(CONCAT('anon-contact-', id), 256));

-- @table feedback_comments
UPDATE feedback_comments SET
  author_label = IF(author_label IS NULL OR author_label = '', author_label, 'Staff'),
  body = IF(body IS NULL OR body = '', body, CONCAT('Anonymised comment #', id));

-- @table feedback_attachments
UPDATE feedback_attachments SET original_name = CONCAT('attachment-', id);

-- @table leave_requests
UPDATE leave_requests SET
  reason = IF(reason IS NULL OR reason = '', reason, CONCAT('Anonymised reason #', id)),
  decision_note = IF(decision_note IS NULL OR decision_note = '', decision_note, CONCAT('Anonymised note #', id));

-- @table pay_adjustments
UPDATE pay_adjustments SET
  reason = IF(reason IS NULL OR reason = '', reason, CONCAT('Anonymised reason #', id)),
  decision_note = IF(decision_note IS NULL OR decision_note = '', decision_note, CONCAT('Anonymised note #', id));

-- @table pay_profiles
UPDATE pay_profiles SET notes = IF(notes IS NULL OR notes = '', notes, CONCAT('Anonymised notes #', id));

-- @table staff_attendance
UPDATE staff_attendance SET note = IF(note IS NULL OR note = '', note, CONCAT('Anonymised note #', id));

-- @table teacher_blocks
UPDATE teacher_blocks SET note = IF(note IS NULL OR note = '', note, CONCAT('Anonymised note #', id));

-- @table invoices
UPDATE invoices SET
  notes = IF(notes IS NULL OR notes = '', notes, CONCAT('Anonymised notes #', id)),
  void_reason = IF(void_reason IS NULL OR void_reason = '', void_reason, CONCAT('Anonymised reason #', id));

-- @table invoice_lines
UPDATE invoice_lines SET description = CONCAT('Tuition line #', id);

-- @table payments
UPDATE payments SET
  note = IF(note IS NULL OR note = '', note, CONCAT('Anonymised note #', id)),
  checkout_url = IF(checkout_url IS NULL OR checkout_url = '', checkout_url, 'https://checkout.example.test/anon');

-- @table payment_webhook_events
UPDATE payment_webhook_events SET payload = JSON_OBJECT('anonymised', TRUE, 'id', event_id, 'type', type);

-- @table zoom_webhook_events
UPDATE zoom_webhook_events SET payload = JSON_OBJECT('anonymised', TRUE);

-- @table zoom_hosts
UPDATE zoom_hosts SET email = CONCAT('zoomhost', id, '@', @dom), label = CONCAT('Host ', id);

-- @table whatsapp_inbound_messages
UPDATE whatsapp_inbound_messages SET from_hash = SHA2(CONCAT('anon-wa-', id), 256);

-- @table audit_logs
UPDATE audit_logs SET
  ip_address = IF(ip_address IS NULL, NULL, '127.0.0.1'),
  user_agent = IF(user_agent IS NULL, NULL, 'anonymised');

-- @table notifications
UPDATE notifications SET data = JSON_OBJECT('anonymised', TRUE);

-- @table announcements
UPDATE announcements SET description = IF(description IS NULL OR description = '', description, CONCAT('Anonymised announcement #', id));

-- @table complains
UPDATE complains SET title = CONCAT('Complaint #', id), description = IF(description IS NULL, NULL, CONCAT('Anonymised complaint #', id));

-- @table tasks
UPDATE tasks SET content = IF(content IS NULL, NULL, CONCAT('Anonymised task #', id));

-- @table task_comments
UPDATE task_comments SET comment = IF(comment IS NULL, NULL, CONCAT('Anonymised comment #', id));

-- @table expenses
UPDATE expenses SET title = CONCAT('Expense #', id), description = IF(description IS NULL, NULL, 'Anonymised');

-- @table transactions
UPDATE transactions SET callback = NULL, link = NULL;

-- @table password_reset_tokens
TRUNCATE TABLE password_reset_tokens;
-- @table sessions
TRUNCATE TABLE sessions;
-- @table personal_access_tokens
TRUNCATE TABLE personal_access_tokens;
-- @table jobs
TRUNCATE TABLE jobs;
-- @table failed_jobs
TRUNCATE TABLE failed_jobs;
-- @table job_batches
TRUNCATE TABLE job_batches;
-- @table cache
TRUNCATE TABLE cache;
-- @table cache_locks
TRUNCATE TABLE cache_locks;

-- @table _teardown
SET FOREIGN_KEY_CHECKS = 1;
