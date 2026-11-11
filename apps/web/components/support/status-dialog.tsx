'use client';

import {
  NOTE_REQUIRED_STATUSES,
  PRIORITY_REQUIRED_STATUSES,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_HINTS,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TRANSITIONS,
  updateTicketSchema,
  type TicketDto,
  type TicketPriority,
  type TicketStatus,
  type UpdateTicketInput,
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
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useUiLocale } from '@/components/sessions/times';
import { supportKeys, updateTicket } from '@/lib/api/support';
import { useSupportError } from '@/lib/support/errors';

const noteRequired = (s: TicketStatus | '') =>
  (NOTE_REQUIRED_STATUSES as readonly string[]).includes(s);
const priorityRequired = (s: TicketStatus | '') =>
  (PRIORITY_REQUIRED_STATUSES as readonly string[]).includes(s);
const prPattern = updateTicketSchema.shape.prUrl;

/**
 * Move a ticket (docs/22 §3, D97), in the inbox and on the ticket: the next statuses the lifecycle
 * allows; a note to the requester is required for «بانتظار معلومات» and «مغلق دون تنفيذ»
 * (optional for «تم الحل»); a priority before «قيد المراجعة / قيد التنفيذ / تم الحل»; a
 * technical fix needs its pull request link. The same rules are enforced by the API (422).
 */
export function StatusDialog({
  ticket,
  open,
  onOpenChange,
  initial,
}: {
  ticket: Pick<TicketDto, 'id' | 'number' | 'status' | 'priority' | 'category' | 'prUrl'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: TicketStatus;
}) {
  const t = useTranslations('support.triage');
  const tf = useTranslations('support.form');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useSupportError();
  const statusId = useId();
  const priorityId = useId();
  const noteId = useId();
  const prId = useId();
  const next = TICKET_TRANSITIONS[ticket.status];
  const [status, setStatus] = useState<TicketStatus | ''>(initial ?? '');
  const [priority, setPriority] = useState<TicketPriority | ''>(ticket.priority ?? '');
  const [note, setNote] = useState('');
  const [pr, setPr] = useState(ticket.prUrl ?? '');
  const [touched, setTouched] = useState(false);

  const needsPriority = priorityRequired(status) && !ticket.priority;
  const needsPr = status === 'fixed' && ticket.category === 'technical';
  const missing = {
    status: !status,
    priority: needsPriority && !priority,
    note: noteRequired(status) && !note.trim(),
    pr: needsPr && !pr.trim(),
    prInvalid: needsPr && !!pr.trim() && !prPattern.safeParse(pr.trim()).success,
  };

  const save = useMutation({
    mutationFn: () => {
      const body: UpdateTicketInput = {
        status: status as TicketStatus,
        ...(needsPriority && priority ? { priority } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(needsPr ? { prUrl: pr.trim() } : {}),
      };
      return updateTicket(ticket.id, body);
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(supportKeys.ticket(ticket.id), detail);
      void queryClient.invalidateQueries({ queryKey: supportKeys.all });
      toast.success(t('saved'));
      change(false);
    },
  });

  function change(nextOpen: boolean) {
    if (!nextOpen) {
      setStatus(initial ?? '');
      setNote('');
      setTouched(false);
      save.reset();
    }
    onOpenChange(nextOpen);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (Object.values(missing).some(Boolean)) return;
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && change(o)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {status
                ? t('moveTitle', {
                    number: ticket.number,
                    status: TICKET_STATUS_LABELS[status][locale],
                  })
                : t('status')}
            </DialogTitle>
            <DialogDescription>
              <bdi>{ticket.number}</bdi> · {TICKET_STATUS_LABELS[ticket.status][locale]}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={touched && missing.status}>
              <FieldLabel htmlFor={statusId}>{t('status')}</FieldLabel>
              <Select value={status} onValueChange={(v) => setStatus(v as TicketStatus)}>
                <SelectTrigger id={statusId} className="h-10! w-full">
                  <SelectValue placeholder={t('status')} />
                </SelectTrigger>
                <SelectContent position="popper">
                  {next.map((s) => (
                    <SelectItem key={s} value={s}>
                      {TICKET_STATUS_LABELS[s][locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {needsPriority && (
              <Field data-invalid={touched && missing.priority}>
                <FieldLabel htmlFor={priorityId}>
                  {t('priority')}
                  <span aria-hidden className="text-destructive">
                    *
                  </span>
                </FieldLabel>
                <Select value={priority} onValueChange={(v) => setPriority(v as TicketPriority)}>
                  <SelectTrigger
                    id={priorityId}
                    className="h-10! w-full"
                    aria-invalid={touched && missing.priority}
                  >
                    <SelectValue placeholder={t('priority')} />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {TICKET_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {TICKET_PRIORITY_LABELS[p][locale]} — {TICKET_PRIORITY_HINTS[p][locale]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {touched && missing.priority ? (
                  <FieldError>{t('priorityFirst')}</FieldError>
                ) : (
                  <FieldDescription>{t('priorityHelp')}</FieldDescription>
                )}
              </Field>
            )}
            {needsPr && (
              <Field data-invalid={touched && (missing.pr || missing.prInvalid)}>
                <FieldLabel htmlFor={prId}>
                  {t('prRequired')}
                  <span aria-hidden className="text-destructive">
                    *
                  </span>
                </FieldLabel>
                <Input
                  id={prId}
                  dir="ltr"
                  value={pr}
                  placeholder={t('prHelp')}
                  aria-invalid={touched && (missing.pr || missing.prInvalid)}
                  onChange={(e) => setPr(e.target.value)}
                />
                {touched && missing.pr && <FieldError>{t('prRequired')}</FieldError>}
                {touched && missing.prInvalid && <FieldError>{t('prInvalid')}</FieldError>}
              </Field>
            )}
            {status && (
              <Field data-invalid={touched && missing.note}>
                <FieldLabel htmlFor={noteId}>
                  {t('noteLabel')}
                  {noteRequired(status) && (
                    <span aria-hidden className="text-destructive">
                      *
                    </span>
                  )}
                </FieldLabel>
                <Textarea
                  id={noteId}
                  rows={3}
                  maxLength={2000}
                  value={note}
                  aria-invalid={touched && missing.note}
                  onChange={(e) => setNote(e.target.value)}
                />
                {touched && missing.note ? (
                  <FieldError>{t('noteRequired')}</FieldError>
                ) : (
                  <FieldDescription>
                    {noteRequired(status) ? t('noteRequired') : t('noteOptional')}
                  </FieldDescription>
                )}
              </Field>
            )}
          </FieldGroup>
          {save.isError && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{message(save.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={save.isPending}>
                {tf('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              {t('move')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
