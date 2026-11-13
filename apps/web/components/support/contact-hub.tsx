'use client';

import {
  PARENT_CONTACT_CARDS,
  TEACHER_CONTACT_CARDS,
  type ContactUsCard,
  type ContactUsChoice,
  type RequestType,
  type SessionDto,
  type TicketType,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@qarabic/ui/components/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@qarabic/ui/components/item';
import { Separator } from '@qarabic/ui/components/separator';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  BugIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  GraduationCapIcon,
  LightbulbIcon,
  ReceiptTextIcon,
  UserSearchIcon,
  WalletIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RequestDialog } from '@/components/requests/request-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { fetchPeopleList } from '@/lib/api/people';
import { fetchSessions, sessionKeys } from '@/lib/api/sessions';
import { fetchMine, supportKeys } from '@/lib/api/support';
import { can } from '@/lib/auth/use-me';
import { dayAndClock } from '@/lib/schedule-time';
import { audienceOf, type Audience } from '@/lib/support/labels';
import { TicketStatusBadge } from './badges';
import {
  TicketFormDialog,
  type Behalf,
  type FormKey,
  type TicketIntent,
} from './ticket-form-dialog';

const DAY = 86_400_000;
const LIVE = ['scheduled', 'leave'];

const ICONS: Record<string, LucideIcon> = {
  classes: CalendarDaysIcon,
  teacher: GraduationCapIcon,
  billing: ReceiptTextIcon,
  technical: BugIcon,
  salary: WalletIcon,
  suggestion: LightbulbIcon,
  onBehalf: UserSearchIcon,
};

/** Staff get three cards (S1b): a technical problem, a suggestion, a request on someone's behalf. */
type StaffCard = 'technical' | 'suggestion' | 'onBehalf';

/** What one class offers inside a card (docs/32 §2b): a request (leave, reschedule) or a ticket. */
export type ClassAction =
  | { kind: 'request'; type: Extract<RequestType, 'leave' | 'reschedule'> }
  | { kind: 'ticket'; key: FormKey; choice: ContactUsChoice };

/** The class actions of a card's session choices that this class allows now. */
export function classActions(
  s: SessionDto,
  choices: ContactUsChoice[],
  mayRequest: boolean,
): ClassAction[] {
  const ahead =
    s.stage === 'scheduled' &&
    !s.attention.includes('late') &&
    !s.attention.includes('needs_entry');
  const pending = new Set(s.pendingRequests.map((r) => r.type));
  return choices.flatMap((c): ClassAction[] => {
    if (c.subject !== 'session') return [];
    if (c.requestType === 'leave' || c.requestType === 'reschedule') {
      return mayRequest && ahead && !pending.has(c.requestType)
        ? [{ kind: 'request', type: c.requestType }]
        : [];
    }
    return [{ kind: 'ticket', key: (c.subcategory ?? 'session_issue') as FormKey, choice: c }];
  });
}

/** «تواصل معنا»: the label of a choice / class action. */
export function useActionLabel() {
  const t = useTranslations('support.actions');
  const tf = useTranslations('support.form.choice');
  return (a: ClassAction) =>
    a.kind === 'request'
      ? t(a.type === 'leave' ? 'leave' : 'reschedule')
      : a.key === 'session_issue'
        ? t('issue')
        : tf(a.key);
}

/** «الحصص القادمة» inside a card: the next classes with their actions, one tap to the form. */
function UpcomingClasses({
  audience,
  studentId,
  choices,
  onAction,
}: {
  audience: Audience;
  studentId?: number;
  choices: ContactUsChoice[];
  onAction: (s: SessionDto, a: ClassAction) => void;
}) {
  const t = useTranslations('support.contact');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const label = useActionLabel();
  const [range] = useState(() => {
    const now = Date.now();
    return { from: new Date(now).toISOString(), to: new Date(now + 14 * DAY).toISOString() };
  });
  const query = { from: range.from, to: range.to, perPage: 100, studentId };
  const sessions = useQuery({
    queryKey: sessionKeys.list(query),
    queryFn: ({ signal }) => fetchSessions(query, signal),
  });
  const mayRequest = can(me, 'session_requests.request') || can(me, 'session_requests.manage');
  const groups = useMemo(() => {
    const now = Date.parse(range.from);
    const rows = (sessions.data?.data ?? [])
      .filter((s) => LIVE.includes(s.stage) && Date.parse(s.endsAt) > now)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    if (audience === 'teacher') return [{ id: 0, name: '', rows: rows.slice(0, 5) }];
    const byChild = new Map<number, { id: number; name: string; rows: SessionDto[] }>();
    for (const s of rows) {
      const g = byChild.get(s.student.id) ?? { id: s.student.id, name: s.student.name, rows: [] };
      if (g.rows.length < 3) g.rows.push(s);
      byChild.set(s.student.id, g);
    }
    return [...byChild.values()];
  }, [sessions.data, audience, range.from]);

  return (
    <section aria-labelledby="hub-classes" className="flex flex-col gap-2">
      <h3 id="hub-classes" className="font-bold">
        {t('nextClasses')}
      </h3>
      {sessions.isPending ? (
        <Skeleton className="h-24" />
      ) : sessions.isError ? (
        <p className="text-sm text-destructive">{t('noClasses')}</p>
      ) : groups.every((g) => g.rows.length === 0) ? (
        <p className="text-sm text-muted-foreground">{t('noClasses')}</p>
      ) : (
        groups.map((g) => (
          <div key={g.id} className="flex flex-col gap-2">
            {g.name && groups.length > 1 && (
              <h4 className="text-sm font-semibold text-muted-foreground">{g.name}</h4>
            )}
            <ul className="flex flex-col gap-2">
              {g.rows.map((s) => {
                const when = dayAndClock(s.startsAt, tz, locale);
                const actions = classActions(s, choices, mayRequest);
                return (
                  <li key={s.id}>
                    <Item variant="outline" className="items-start">
                      <ItemContent>
                        <ItemTitle>
                          <bdi>{when}</bdi>
                        </ItemTitle>
                        <ItemDescription>
                          {locale === 'en' ? s.course.nameEn : s.course.nameAr}
                          {audience === 'teacher' ? ` · ${s.student.name}` : ` · ${s.teacher.name}`}
                        </ItemDescription>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {actions.map((a) => (
                            <Button
                              key={a.kind === 'request' ? a.type : a.key}
                              size="sm"
                              variant={a.kind === 'ticket' ? 'ghost' : 'outline'}
                              className="h-9"
                              onClick={() => onAction(s, a)}
                              aria-label={`${label(a)} · ${when}`}
                            >
                              {label(a)}
                            </Button>
                          ))}
                        </div>
                      </ItemContent>
                    </Item>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/** «طلباتي» under the cards: the open ones first, then a link to all. */
function MyOpenRequests({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslations('support');
  const query = { status: 'open' as const, perPage: 3 };
  const list = useQuery({
    queryKey: supportKeys.mine(query),
    queryFn: ({ signal }) => fetchMine(query, signal),
  });
  const rows = list.data?.data ?? [];
  return (
    <section aria-labelledby="hub-mine" className="flex flex-col gap-2">
      <h3 id="hub-mine" className="font-bold">
        {t('contact.mine')}
      </h3>
      {list.isPending ? (
        <Skeleton className="h-10" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('contact.noOpen')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-2 text-sm">
              {r.ticket ? (
                <>
                  <Link
                    href={`/tickets/${r.id}`}
                    onClick={onNavigate}
                    className="font-medium text-primary hover:underline"
                  >
                    <bdi>{r.ticket.number}</bdi> · {r.title}
                  </Link>
                  <TicketStatusBadge status={r.ticket.status} />
                </>
              ) : (
                <Link
                  href="/my-requests"
                  onClick={onNavigate}
                  className="font-medium text-primary hover:underline"
                >
                  {t(`mine.kind.session_request`)} · {r.title}
                </Link>
              )}
              {r.nextStep && (
                <span className="text-muted-foreground">{t(`mine.nextStep.${r.nextStep}`)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/my-requests"
        onClick={onNavigate}
        className="self-start text-sm font-medium text-primary hover:underline"
      >
        {t('contact.allMine')}
      </Link>
    </section>
  );
}

/** A large «بخصوص ماذا؟» card: icon, title and a one-line hint (two columns, ≥ 44 px targets). */
function CardButton({
  icon: Icon,
  title,
  hint,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <Item variant="outline" asChild className="h-full items-start p-4 hover:bg-subtle">
      <button type="button" onClick={onClick} className="text-start">
        <ItemMedia variant="icon" className="text-primary [&_svg]:size-6!">
          <Icon aria-hidden />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="text-base font-bold">{title}</ItemTitle>
          <ItemDescription className="line-clamp-none">{hint}</ItemDescription>
        </ItemContent>
      </button>
    </Item>
  );
}

/** A full-width choice inside a card (one tap to its form). */
function ChoiceButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Item variant="outline" asChild className="min-h-12 hover:bg-subtle">
      <button type="button" onClick={onClick} className="text-start">
        <ItemContent>
          <ItemTitle className="text-body">{label}</ItemTitle>
        </ItemContent>
        <ItemActions>
          <ChevronLeftIcon aria-hidden className="size-4 ltr:rotate-180" />
        </ItemActions>
      </button>
    </Item>
  );
}

/** Staff on behalf (S1b): find the student by name, email or phone. */
function StudentSearch({ onPick }: { onPick: (b: Behalf) => void }) {
  const t = useTranslations('support.contact.behalf');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);
  const query = { q: q || undefined, perPage: 8 };
  const students = useQuery({
    queryKey: ['support', 'behalf', query],
    queryFn: ({ signal }) => fetchPeopleList('students', query, signal),
  });
  const rows = students.data?.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">{t('intro')}</p>
      {/* cmdk names its input from `label` (an aria-label on the input is overridden). */}
      <Command shouldFilter={false} label={t('search')} className="rounded-lg border">
        <CommandInput
          value={input}
          onValueChange={setInput}
          placeholder={t('placeholder')}
          autoFocus
        />
        <CommandList label={t('results')}>
          {!students.isPending && <CommandEmpty>{t('none')}</CommandEmpty>}
          <CommandGroup>
            {rows.map((s) => (
              <CommandItem
                key={s.id}
                value={String(s.id)}
                onSelect={() => onPick({ studentId: s.id, name: s.name, familyId: s.familyId })}
              >
                <span className="flex flex-col">
                  <span>{s.name}</span>
                  {s.family.parentName && (
                    <span className="text-xs text-muted-foreground">{s.family.parentName}</span>
                  )}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

/** What a `/contact` deep link asks for (S5 `contactPath`): a card, a choice, and its subject. */
export interface ContactDeepLink {
  card?: string;
  choice?: string;
  sessionId?: number;
  invoiceId?: number;
  studentId?: number;
  /**
   * The invoice number or the child's name, once looked up for this family. Without it the form
   * opens without a subject (an id that isn't theirs, or a lookup that failed).
   */
  subjectLabel?: string;
}

/**
 * Where a deep link starts: its card, or its choice's pre-filled form with the invoice or child.
 * A class choice starts on the card (the class is picked there); technical and suggestion go
 * through the screenshot report, so they start on the card too.
 */
function deepLinkStart(
  link: ContactDeepLink | undefined,
  cards: ContactUsCard[],
): { view: View; child: Child | null } {
  const card = link && cards.find((c) => c.key === link.card);
  if (!link || !card) return { view: { at: 'home' }, child: null };
  const choice = card.choices.find((c) => c.key === link.choice);
  if (
    !choice ||
    choice.subject === 'session' ||
    choice.category === 'technical' ||
    choice.category === 'suggestion'
  ) {
    return { view: { at: 'card', card }, child: null };
  }
  const subject = !link.subjectLabel
    ? undefined
    : link.invoiceId && choice.subject === 'invoice'
      ? { type: 'invoice' as const, id: link.invoiceId, label: link.subjectLabel }
      : link.studentId && choice.subject === 'student'
        ? { type: 'student' as const, id: link.studentId, label: link.subjectLabel }
        : undefined;
  return {
    view: { at: 'card', card },
    child: {
      kind: 'ticket',
      intent: { ...intentOf(choice), ...(subject ? { subject, picker: undefined } : {}) },
    },
  };
}

type View =
  | { at: 'home' }
  | { at: 'card'; card: ContactUsCard }
  | { at: 'search' }
  | { at: 'behalf'; behalf: Behalf }
  | { at: 'behalfCard'; behalf: Behalf; card: ContactUsCard };

type Child =
  | { kind: 'ticket'; intent: TicketIntent }
  | { kind: 'request'; session: SessionDto; type: RequestType };

const intentOf = (c: ContactUsChoice, behalf?: Behalf): TicketIntent => ({
  key: (c.subcategory ?? c.key) as FormKey,
  category: c.category,
  ...(c.subcategory ? { subcategory: c.subcategory } : {}),
  ...(c.subject === 'student' && !behalf ? { picker: 'student' as const } : {}),
  ...(behalf ? { behalf } : {}),
});

/**
 * «تواصل معنا» hub (docs/32 §2b): «بخصوص ماذا؟» with large cards for the user's portal, a small
 * «موضوع آخر» link and «طلباتي» below. A card opens its ≤ 4 choices (the class choices start from
 * the next classes); a choice opens the short pre-filled form. Two taps at most. Staff get a
 * technical problem, a suggestion and a request on behalf of a parent or student, which shows the
 * parent's cards for the picked student.
 */
export function ContactHub({
  open,
  onOpenChange,
  onReport,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** «مشكلة تقنية» / «اقتراح»: the screenshot report owned by the button. */
  onReport: (type: TicketType) => void;
  /** A deep link (`/contact?card=…&choice=…`, S5): where the hub opens instead of its home. */
  initial?: ContactDeepLink;
}) {
  const t = useTranslations('support.contact');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const audience = audienceOf(me);
  const cards =
    audience === 'parent'
      ? PARENT_CONTACT_CARDS
      : audience === 'teacher'
        ? TEACHER_CONTACT_CARDS
        : [];
  // A deep link starts on its card, or on its choice's pre-filled form (S5).
  const [start] = useState(() => deepLinkStart(initial, cards));
  const [view, setView] = useState<View>(start.view);
  const [child, setChild] = useState<Child | null>(start.child);
  const staffCards: StaffCard[] = [
    'technical',
    'suggestion',
    ...(can(me, 'families.view') ? (['onBehalf'] as const) : []),
  ];

  const reset = () => setView({ at: 'home' });
  const close = () => {
    onOpenChange(false);
    reset();
  };

  const pick = (c: ContactUsChoice, behalf?: Behalf) => {
    if (!behalf && (c.category === 'technical' || c.category === 'suggestion')) {
      close();
      onReport(c.category === 'technical' ? 'bug' : 'feature');
      return;
    }
    setChild({ kind: 'ticket', intent: intentOf(c, behalf) });
  };

  const openCard = (card: ContactUsCard, behalf?: Behalf) => {
    const plain = card.choices.filter((c) => c.subject !== 'session');
    // A single-choice card without classes opens its form at once.
    if (card.choices.length === 1 && plain.length === 1) pick(plain[0]!, behalf);
    else setView(behalf ? { at: 'behalfCard', behalf, card } : { at: 'card', card });
  };

  const onClassAction = (s: SessionDto, a: ClassAction, behalf?: Behalf) => {
    if (a.kind === 'request') {
      setChild({ kind: 'request', session: s, type: a.type });
      return;
    }
    const label = [
      dayAndClock(s.startsAt, tz, locale),
      locale === 'en' ? s.course.nameEn : s.course.nameAr,
      s.student.name,
    ]
      .filter(Boolean)
      .join(' · ');
    setChild({
      kind: 'ticket',
      intent: {
        ...intentOf(a.choice, behalf),
        picker: undefined,
        subject: { type: 'session', id: s.id, label },
      },
    });
  };

  const back = () => {
    if (view.at === 'card' || view.at === 'search') reset();
    else if (view.at === 'behalf') setView({ at: 'search' });
    else if (view.at === 'behalfCard') setView({ at: 'behalf', behalf: view.behalf });
  };

  const title =
    view.at === 'card' || view.at === 'behalfCard'
      ? view.card.label[locale]
      : view.at === 'search' || view.at === 'behalf'
        ? t('staffCards.onBehalf')
        : t('title');

  const parentCards = (behalf?: Behalf): ReactNode => (
    <>
      <h3 className="text-lg font-bold">{t('about')}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(behalf ? PARENT_CONTACT_CARDS : cards).map((card) => (
          <CardButton
            key={card.key}
            icon={ICONS[card.key] ?? BugIcon}
            title={card.label[locale]}
            hint={card.hint[locale]}
            onClick={() => openCard(card, behalf)}
          />
        ))}
      </div>
      <Button
        variant="link"
        className="h-11 self-start px-0 text-base"
        onClick={() => pick({ key: 'other', label: { ar: '', en: '' }, category: 'other' }, behalf)}
      >
        {t('other')}
      </Button>
    </>
  );

  const cardChoices = (card: ContactUsCard, behalf?: Behalf): ReactNode => {
    const sessionChoices = card.choices.filter((c) => c.subject === 'session');
    const plain = card.choices.filter((c) => c.subject !== 'session');
    return (
      <>
        {sessionChoices.length > 0 && (
          <UpcomingClasses
            audience={behalf ? 'staff' : audience}
            studentId={behalf?.studentId}
            choices={sessionChoices}
            onAction={(s, a) => onClassAction(s, a, behalf)}
          />
        )}
        {plain.length > 0 && (
          <div className="flex flex-col gap-2">
            {plain.map((c) => (
              <ChoiceButton key={c.key} label={c.label[locale]} onClick={() => pick(c, behalf)} />
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <>
      <Dialog open={open && !child} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
        <DialogContent
          className="max-h-[92svh] overflow-y-auto sm:max-w-xl"
          data-feedback-ignore
          aria-describedby="contact-hub-description"
        >
          <DialogHeader className="flex-row items-center gap-2 space-y-0">
            {view.at !== 'home' && (
              <Button variant="ghost" size="icon" aria-label={t('back')} onClick={back}>
                <ArrowRightIcon className="ltr:rotate-180" />
              </Button>
            )}
            <div className="flex min-w-0 flex-col gap-1 text-start">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription id="contact-hub-description">
                {view.at === 'home'
                  ? t('subtitle')
                  : view.at === 'card' || view.at === 'behalfCard'
                    ? view.card.hint[locale]
                    : t('staffHints.onBehalf')}
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {view.at === 'home' &&
              (audience === 'staff' ? (
                <>
                  <h3 className="text-lg font-bold">{t('about')}</h3>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {staffCards.map((k) => (
                      <CardButton
                        key={k}
                        icon={ICONS[k]!}
                        title={t(`staffCards.${k}`)}
                        hint={t(`staffHints.${k}`)}
                        onClick={() => {
                          if (k === 'onBehalf') setView({ at: 'search' });
                          else {
                            close();
                            onReport(k === 'technical' ? 'bug' : 'feature');
                          }
                        }}
                      />
                    ))}
                  </div>
                </>
              ) : (
                parentCards()
              ))}
            {view.at === 'card' && cardChoices(view.card)}
            {view.at === 'search' && (
              <StudentSearch onPick={(behalf) => setView({ at: 'behalf', behalf })} />
            )}
            {(view.at === 'behalf' || view.at === 'behalfCard') && (
              <Alert>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t('behalf.for', { name: view.behalf.name })}</span>
                  {view.at === 'behalf' && (
                    <Button size="sm" variant="outline" onClick={() => setView({ at: 'search' })}>
                      {t('behalf.change')}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {view.at === 'behalf' && parentCards(view.behalf)}
            {view.at === 'behalfCard' && cardChoices(view.card, view.behalf)}
            {view.at === 'home' && (
              <>
                <Separator />
                {open && <MyOpenRequests onNavigate={close} />}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {child?.kind === 'ticket' && (
        <TicketFormDialog
          intent={child.intent}
          open
          onOpenChange={(next) => {
            if (!next) {
              setChild(null);
              close();
            }
          }}
        />
      )}
      {child?.kind === 'request' && (
        <RequestDialog
          session={child.session}
          type={child.type}
          open
          onOpenChange={(next) => {
            if (!next) {
              setChild(null);
              close();
            }
          }}
        />
      )}
    </>
  );
}
