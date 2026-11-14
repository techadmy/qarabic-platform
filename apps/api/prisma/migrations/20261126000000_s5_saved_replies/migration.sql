-- S5 WhatsApp off-ramp (docs/32 §7): saved replies with a deep link.

-- CreateTable
CREATE TABLE "support_saved_replies" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "title_ar" VARCHAR(120) NOT NULL,
    "title_en" VARCHAR(120) NOT NULL,
    "body_ar" VARCHAR(2000) NOT NULL,
    "body_en" VARCHAR(2000) NOT NULL,
    "link" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_saved_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_saved_replies_key_key" ON "support_saved_replies"("key");

-- The common requests (staff can edit or add more).
INSERT INTO "support_saved_replies" ("key", "title_ar", "title_en", "body_ar", "body_en", "link") VALUES
('contact_us', 'تواصل معنا من النظام', 'Contact us in the app',
 'السلام عليكم {name}، يسعدنا خدمتكم. لتصل طلباتكم أسرع، أرسلوها من «تواصل معنا» في النظام: {link}',
 'Assalamu alaikum {name}, we are happy to help. Your requests reach us faster through «Contact us» in the app: {link}',
 '{}'),
('reschedule', 'تغيير موعد حصة', 'Change a class time',
 'لتغيير موعد الحصة، اختر الموعد الجديد من هنا وسيصلنا طلبك مباشرة: {link}',
 'To change the class time, pick the new time here and your request reaches us directly: {link}',
 '{"card":"classes","choice":"reschedule"}'),
('leave', 'الاعتذار عن حصة', 'Excuse from a class',
 'للاعتذار عن الحصة، سجّل الاعتذار من هنا: {link}',
 'To excuse the child from a class, send it here: {link}',
 '{"card":"classes","choice":"leave"}'),
('invoice_question', 'استفسار عن فاتورة', 'Invoice question',
 'لأي استفسار عن الفاتورة أو الدفع، أرسله من هنا مع صورة الإيصال إن وجدت: {link}',
 'For any question about the invoice or a payment, send it here with the receipt if you have one: {link}',
 '{"card":"billing","choice":"invoice_question"}'),
('teacher_change', 'طلب تغيير المعلم', 'Ask for another teacher',
 'لطلب تغيير المعلم، أرسل الطلب من هنا وسنقترح عليكم معلمًا مناسبًا: {link}',
 'To ask for another teacher, send the request here and we will propose a suitable one: {link}',
 '{"card":"teacher","choice":"teacher_change"}');
