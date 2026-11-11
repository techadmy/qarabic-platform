'use client';

import type { TicketContext, TicketType } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';
import { HeadsetIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { collectContext } from '@/lib/support/context';
import { canReport } from '@/lib/support/labels';
import { capturePage } from '@/lib/support/screenshot';
import { ContactHub } from './contact-hub';
import { EMPTY_DRAFT, ReportDialog, type ReportDraft } from './report-dialog';

/**
 * «تواصل معنا» in the top bar on every screen (docs/32 §2b, docs/22 §5.1): text from `md` up, an
 * icon on phones. The page is captured first, before any dialog covers it, so a technical report
 * carries a screenshot of what the user was looking at; then the «بخصوص ماذا؟» hub opens.
 */
export function ContactButton() {
  const t = useTranslations('support.contact');
  const me = useCurrentUser();
  const locale = useLocale();
  const tz = useViewerTz();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [hub, setHub] = useState(false);
  const [report, setReport] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureFailed, setCaptureFailed] = useState(false);
  const [screenshot, setScreenshot] = useState<Blob | null>(null);
  const [context, setContext] = useState<TicketContext | null>(null);
  const [draft, setDraft] = useState<ReportDraft>(EMPTY_DRAFT);

  if (!canReport(me)) return null;

  const start = () => {
    setContext(
      collectContext({
        pathname,
        search: search ? `?${search}` : '',
        displayZone: tz,
        locale,
        portal: me.role?.kind ?? null,
      }),
    );
    setCapturing(true);
    setCaptureFailed(false);
    setScreenshot(null);
    void capturePage().then((blob) => {
      setScreenshot(blob);
      setCaptureFailed(!blob);
      setCapturing(false);
    });
    setHub(true);
  };

  const openReport = (type: TicketType) => {
    setDraft((d) => ({ ...d, type }));
    setReport(true);
  };

  const label = t('button');
  return (
    <>
      <Button
        variant="outline"
        className="hidden h-9 md:inline-flex"
        onClick={start}
        data-feedback-ignore
      >
        <HeadsetIcon />
        {label}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-9 md:hidden"
            aria-label={label}
            onClick={start}
            data-feedback-ignore
          >
            <HeadsetIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <ContactHub open={hub} onOpenChange={setHub} onReport={openReport} />
      <ReportDialog
        open={report}
        onOpenChange={setReport}
        capturing={capturing}
        screenshot={screenshot}
        captureFailed={captureFailed}
        context={context}
        draft={draft}
        onDraft={setDraft}
        onRemoveScreenshot={() => setScreenshot(null)}
        onSent={() => {
          setReport(false);
          setScreenshot(null);
        }}
      />
    </>
  );
}
