'use client';

import {
  STAFF_TICKET_CHANNELS,
  TICKET_CHANNEL_LABELS,
  type TicketCategory,
  type TicketSubcategory,
  type TicketSubjectType,
  isTypedRequest,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@qarabic/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { fetchPeopleList } from '@/lib/api/people';
import { createTicket, supportKeys } from '@/lib/api/support';
import { dateKeyIn } from '@/lib/schedule-time';
import { emptyRequest, RequestFields, requestPayload, type RequestDraft } from './request-fields';
import { collectContext } from '@/lib/support/context';
import { useSupportError } from '@/lib/support/errors';

/** The form keys under `support.form.{ask,hint,choice}`. */
export type FormKey =
  TicketSubcategory | 'other' | 'technical' | 'suggestion' | 'makeup' | 'session_issue';

/** The student a staff member files for (docs/32 §3); the subject defaults to them. */
export interface Behalf {
  studentId: number;
  name: string;
  familyId: number;
}

/** What a short «تواصل معنا» form is for: the topic, the pre-filled subject or a picker. */
export interface TicketIntent {
  key: FormKey;
  category: TicketCategory;
  subcategory?: TicketSubcategory;
  /** Pre-filled from a class card, a class sheet or an invoice. */
  subject?: { type: TicketSubjectType; id: number; label: string };
  /** Let the parent pick a child (the first is pre-selected; «جميع الأبناء» sends none). */
  picker?: 'student';
  /** The child a class-based request is about (S3: schedule change from a class card). */
  studentId?: number;
  behalf?: Behalf;
}

const ALL = 'all';
const MIN = 10;

function ChildPicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Said under the field (a typed request is about one child). */
  error?: string;
}) {
  const t = useTranslations('support.form');
  const id = useId();
  const kids = useQuery({
    queryKey: ['support', 'children'],
    queryFn: ({ signal }) => fetchPeopleList('students', { perPage: 50 }, signal),
  });
  const rows = kids.data?.data ?? [];
  const first = rows[0]?.id;
  // The first child is picked by default, so the request is about someone.
  useEffect(() => {
    if (!value && first) onChange(String(first));
  }, [value, first, onChange]);
  if (rows.length === 0) return null;
  const current = value || String(first);
  return (
    <Field data-invalid={!!error || undefined}>
      <FieldLabel htmlFor={id}>{t('child')}</FieldLabel>
      <Select value={current} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-10! w-full" aria-invalid={!!error || undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {rows.map((k) => (
            <SelectItem key={k.id} value={String(k.id)}>
              {k.name}
            </SelectItem>
          ))}
          {rows.length > 1 && <SelectItem value={ALL}>{t('allChildren')}</SelectItem>}
        </SelectContent>
      </Select>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}

/**
 * The short «تواصل معنا» form (docs/32 §2b): titled after the choice, with the subject it came
 * from (a class, an invoice) or a child picker, one text field with an example, and «أرسل». On
 * success it says where the answer will appear («طلباتي»). A complaint about a teacher says the
 * teacher will not see it (the server routes it to the restricted «الشكاوى» queue).
 */
export function TicketFormDialog({
  intent,
  open,
  onOpenChange,
  onSent,
}: {
  intent: TicketIntent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
}) {
  const t = useTranslations('support.form');
  const tb = useTranslations('support.contact.behalf');
  const tr = useTranslations('support.request');
  const locale = useLocale();
  const ui = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const queryClient = useQueryClient();
  const message = useSupportError();
  const textId = useId();
  const channelId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [child, setChild] = useState('');
  const [channel, setChannel] = useState<(typeof STAFF_TICKET_CHANNELS)[number]>('phone');
  const [touched, setTouched] = useState(false);
  const trimmed = text.trim();
  const error = !trimmed ? t('required') : trimmed.length < MIN ? t('short') : null;
  const behalf = intent.behalf;
  // S3: a typed request (schedule / teacher / subscription change, invoice question).
  const kind = isTypedRequest(intent.subcategory) ? intent.subcategory : null;
  const [draft, setDraft] = useState<RequestDraft>(() => emptyRequest(dateKeyIn(tz)));
  const pickedChild = child && child !== ALL ? Number(child) : null;
  const studentId =
    intent.studentId ??
    (intent.subject?.type === 'student' ? intent.subject.id : null) ??
    pickedChild ??
    behalf?.studentId ??
    null;
  const typed = kind ? requestPayload(kind, draft, studentId, tz) : null;
  const typedProblem = !!typed && !typed.payload;

  const create = useMutation({
    mutationFn: () => {
      const picked = intent.picker === 'student' && child && child !== ALL ? Number(child) : null;
      const subject = intent.subject
        ? { subjectType: intent.subject.type, subjectId: intent.subject.id }
        : picked
          ? { subjectType: 'student' as const, subjectId: picked }
          : behalf
            ? { subjectType: 'student' as const, subjectId: behalf.studentId }
            : {};
      return createTicket({
        category: intent.category,
        ...(intent.subcategory ? { subcategory: intent.subcategory } : {}),
        ...subject,
        ...(behalf ? { familyId: behalf.familyId, channel } : {}),
        ...(typed?.payload ? { request: typed.payload } : {}),
        description: trimmed,
        context: collectContext({
          pathname,
          search: search ? `?${search}` : '',
          displayZone: tz,
          locale,
          portal: me.role?.kind ?? null,
        }),
      });
    },
    onSuccess: (ticket) => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.all });
      toast.success(t('sent', { id: ticket.id }));
      setText('');
      setTouched(false);
      onOpenChange(false);
      onSent?.();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (typedProblem) {
      // The first structured field with a problem.
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-ticket-form] [aria-invalid="true"]')?.focus(),
      );
      return;
    }
    if (error) {
      textRef.current?.focus();
      return;
    }
    create.mutate();
  }

  const complaint = intent.category === 'teacher' && intent.subcategory !== 'progress_question';

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg" data-feedback-ignore>
        <form onSubmit={submit} noValidate data-ticket-form className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t(`choice.${intent.key}`)}</DialogTitle>
            {intent.subject ? (
              <DialogDescription>
                {t(`subject.${intent.subject.type}`)}: <bdi>{intent.subject.label}</bdi>
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">{t(`hint.${intent.key}`)}</DialogDescription>
            )}
          </DialogHeader>
          <FieldGroup>
            {behalf && (
              <>
                <Alert>
                  <AlertDescription>{tb('for', { name: behalf.name })}</AlertDescription>
                </Alert>
                <Field>
                  <FieldLabel htmlFor={channelId}>{tb('channel')}</FieldLabel>
                  <Select value={channel} onValueChange={(v) => setChannel(v as typeof channel)}>
                    <SelectTrigger id={channelId} className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {STAFF_TICKET_CHANNELS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {TICKET_CHANNEL_LABELS[c][ui]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </>
            )}
            {!intent.subject && !behalf && intent.picker === 'student' && (
              <ChildPicker
                value={child}
                onChange={setChild}
                error={touched && typed?.errors.studentId ? tr('studentRequired') : undefined}
              />
            )}
            {kind && (
              <div data-typed-request className="flex flex-col gap-4">
                {touched && typed?.errors.studentId && intent.picker !== 'student' && (
                  <p className="text-sm font-medium text-destructive">{tr('studentRequired')}</p>
                )}
                <RequestFields
                  kind={kind}
                  value={draft}
                  onChange={setDraft}
                  errors={typed?.errors ?? {}}
                  showErrors={touched}
                  timezone={tz}
                />
              </div>
            )}
            <Field data-invalid={touched && !!error}>
              <FieldLabel htmlFor={textId}>
                {t(`ask.${intent.key}`)}
                <span aria-hidden className="text-destructive">
                  *
                </span>
              </FieldLabel>
              <Textarea
                ref={textRef}
                id={textId}
                value={text}
                rows={5}
                maxLength={5000}
                required
                aria-invalid={touched && !!error}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => setTouched(true)}
              />
              {touched && error ? (
                <FieldError>{error}</FieldError>
              ) : (
                <FieldDescription>
                  {t(`hint.${intent.key}`)}
                  {complaint && <> {t('teacherHidden')}</>}
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>
          {create.isError && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{message(create.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={create.isPending}>
                {t('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner />}
              {create.isPending ? t('sending') : t('send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
