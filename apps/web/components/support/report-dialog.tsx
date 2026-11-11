'use client';

import { TICKET_UPLOAD_LIMITS, type TicketContext, type TicketType } from '@qarabic/shared';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@qarabic/ui/components/accordion';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Dialog,
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
  FieldLegend,
  FieldSet,
} from '@qarabic/ui/components/field';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, ImagePlusIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { toast } from 'sonner';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { createTicket, supportKeys } from '@/lib/api/support';
import { useSupportError } from '@/lib/support/errors';

const MAX_FILES = TICKET_UPLOAD_LIMITS.maxImagesPerRequest;
const MAX_BYTES = TICKET_UPLOAD_LIMITS.maxImageBytes;
const TYPES: readonly string[] = TICKET_UPLOAD_LIMITS.imageMimes;

/** What the reporter typed; kept when the dialog is closed by mistake. */
export interface ReportDraft {
  type: TicketType;
  description: string;
  images: File[];
}
export const EMPTY_DRAFT: ReportDraft = { type: 'bug', description: '', images: [] };

/** A small preview with an object URL released when the image goes away. */
function Preview({
  blob,
  alt,
  onRemove,
  removeLabel,
}: {
  blob: Blob;
  alt: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="relative">
      {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL */}
      <img src={url} alt={alt} className="h-20 w-30 rounded-md border object-cover" />
      <Button
        type="button"
        size="icon-xs"
        variant="outline"
        className="absolute -end-2 -top-2 rounded-full bg-background"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/**
 * «مشكلة تقنية أو اقتراح» (docs/22 §5.1, docs/32 §2b): the type, what happened, the automatic
 * screenshot of the page (taken before the dialog opened; removable), up to three more images
 * (upload or paste) and the details sent with it, listed so the reporter sees what is sent.
 * Closing keeps the text; «إلغاء» discards it.
 */
export function ReportDialog({
  open,
  onOpenChange,
  capturing,
  screenshot,
  captureFailed,
  context,
  draft,
  onDraft,
  onRemoveScreenshot,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capturing: boolean;
  screenshot: Blob | null;
  captureFailed: boolean;
  context: TicketContext | null;
  draft: ReportDraft;
  onDraft: (d: ReportDraft) => void;
  onRemoveScreenshot: () => void;
  onSent: () => void;
}) {
  const t = useTranslations('support.report');
  const tf = useTranslations('support.form');
  const me = useCurrentUser();
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useSupportError();
  const descId = useId();
  const descRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const { type, description, images } = draft;
  const trimmed = description.trim();
  const descError = !trimmed ? tf('required') : trimmed.length < 10 ? tf('short') : null;

  const create = useMutation({
    mutationFn: () =>
      createTicket(
        {
          type,
          category: type === 'bug' ? 'technical' : 'suggestion',
          description: trimmed,
          context: context ?? {},
        },
        { screenshot, attachments: images },
      ),
    onSuccess: (ticket) => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.all });
      toast.success(tf('sent', { id: ticket.id }));
      onDraft(EMPTY_DRAFT);
      setTouched(false);
      onSent();
    },
  });

  function addFiles(files: File[]) {
    setFileError(null);
    const next = [...images];
    for (const f of files) {
      if (!TYPES.includes(f.type)) {
        setFileError(t('imageType', { name: f.name }));
        continue;
      }
      if (f.size > MAX_BYTES) {
        setFileError(t('imageTooBig', { name: f.name }));
        continue;
      }
      if (next.length >= MAX_FILES) {
        setFileError(t('tooMany'));
        break;
      }
      next.push(f);
    }
    onDraft({ ...draft, images: next });
  }

  function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function submit() {
    setTouched(true);
    if (descError) {
      descRef.current?.focus();
      return;
    }
    create.mutate();
  }

  const zone = context?.displayZone ?? context?.timeZone;
  const details: [string, string][] = context
    ? [
        [t('detail.page'), context.pageUrl ?? '—'],
        [
          t('detail.user'),
          `${me.name}${me.role ? ` (${locale === 'en' ? (me.role.labelEn ?? me.role.labelAr) : me.role.labelAr})` : ''}`,
        ],
        [t('detail.device'), [context.platform, context.viewport].filter(Boolean).join(' · ')],
        [t('detail.version'), context.appVersion ?? '—'],
        [t('detail.zone'), zone ?? '—'],
        [
          t('detail.errors'),
          context.recentErrors?.length
            ? context.recentErrors.map((e) => `${e.method} ${e.path} ${e.status ?? ''}`).join('، ')
            : t('detail.errorsNone'),
        ],
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent
        className="max-h-[92svh] overflow-y-auto sm:max-w-lg"
        onPaste={onPaste}
        data-feedback-ignore
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('intro')}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">{t('type')}</FieldLegend>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              value={type}
              onValueChange={(v) => v && onDraft({ ...draft, type: v as TicketType })}
              aria-label={t('type')}
              className="w-fit"
            >
              {(['bug', 'feature'] as const).map((k) => (
                <ToggleGroupItem
                  key={k}
                  value={k}
                  className="h-9 px-4 data-[state=on]:bg-accent data-[state=on]:font-semibold data-[state=on]:text-accent-foreground"
                >
                  {t(`types.${k}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>{t(`typeHelp.${type}`)}</FieldDescription>
          </FieldSet>
          <Field data-invalid={touched && !!descError}>
            <FieldLabel htmlFor={descId}>
              {type === 'feature' ? t('descriptionFeature') : t('description')}
              <span aria-hidden className="text-destructive">
                *
              </span>
            </FieldLabel>
            <Textarea
              ref={descRef}
              id={descId}
              rows={5}
              maxLength={5000}
              required
              value={description}
              aria-invalid={touched && !!descError}
              onChange={(e) => onDraft({ ...draft, description: e.target.value })}
              onBlur={() => setTouched(true)}
            />
            {touched && descError ? (
              <FieldError>{descError}</FieldError>
            ) : (
              <FieldDescription>
                {type === 'feature' ? t('descriptionHelpFeature') : t('descriptionHelp')}
              </FieldDescription>
            )}
          </Field>
          <FieldSet>
            <FieldLegend variant="label">{t('screenshot')}</FieldLegend>
            <div className="flex flex-wrap items-start gap-3">
              {capturing && (
                <span role="status" className="flex h-20 items-center gap-2 text-sm">
                  <Spinner />
                  {t('capturing')}
                </span>
              )}
              {screenshot && (
                <Preview
                  blob={screenshot}
                  alt={t('screenshot')}
                  onRemove={onRemoveScreenshot}
                  removeLabel={t('removeScreenshot')}
                />
              )}
              {images.map((f, i) => (
                <Preview
                  key={`${f.name}-${i}`}
                  blob={f}
                  alt={f.name}
                  removeLabel={t('removeImage', { name: f.name })}
                  onRemove={() => onDraft({ ...draft, images: images.filter((_, j) => j !== i) })}
                />
              ))}
              {images.length < MAX_FILES && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-20"
                  onClick={() => fileRef.current?.click()}
                >
                  <ImagePlusIcon />
                  {t('addImage')}
                </Button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept={TYPES.join(',')}
                multiple
                hidden
                data-testid="report-file-input"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </div>
            {captureFailed && !screenshot && !capturing && (
              <FieldDescription>{t('captureFailed')}</FieldDescription>
            )}
            <FieldDescription>{t('imagesHelp')}</FieldDescription>
            {fileError && <FieldError>{fileError}</FieldError>}
          </FieldSet>
          <Accordion type="single" collapsible className="rounded-md border px-3">
            <AccordionItem value="details">
              <AccordionTrigger>{t('details')}</AccordionTrigger>
              <AccordionContent>
                <p className="mb-2 text-muted-foreground">{t('detailsHelp')}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  {details.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="break-words [overflow-wrap:anywhere]">
                        <bdi>{v || '—'}</bdi>
                      </dd>
                    </div>
                  ))}
                </dl>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </FieldGroup>
        {create.isError && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{message(create.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={create.isPending}
            onClick={() => {
              onDraft(EMPTY_DRAFT);
              setTouched(false);
              setFileError(null);
              create.reset();
              onOpenChange(false);
            }}
          >
            {tf('cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={create.isPending || capturing}>
            {create.isPending && <Spinner />}
            {create.isPending ? tf('sending') : tf('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
