'use client';

import { Button } from '@qarabic/ui/components/button';
import { ButtonGroup } from '@qarabic/ui/components/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { ChevronDownIcon, EllipsisIcon, PlusIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useDirection } from '@/lib/use-direction';

export type ListAction = {
  label: string;
  icon?: LucideIcon;
  /** A link (navigation) or a click handler (opens a dialog). */
  href?: string;
  onSelect?: () => void;
};

function Item({ action }: { action: ListAction }) {
  const Icon = action.icon;
  return action.href ? (
    <DropdownMenuItem asChild>
      <Link href={action.href}>
        {Icon && <Icon aria-hidden />}
        {action.label}
      </Link>
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem onSelect={action.onSelect}>
      {Icon && <Icon aria-hidden />}
      {action.label}
    </DropdownMenuItem>
  );
}

/**
 * The list header's actions (D141 §4): at most two controls. The primary create button (shadcn
 * `ButtonGroup` split button when there are other create actions behind its chevron) and «⋯» for
 * import, export, sort and settings. Pass only what the user may do; nothing renders when empty.
 */
export function ListActions({
  create,
  moreCreate = [],
  more = [],
}: {
  /** `href` makes it a link (opens in a new tab with a middle-click); `onClick` opens a sheet. */
  create?: { label: string; onClick?: () => void; href?: string };
  /** Other create actions, behind the chevron of the primary button. */
  moreCreate?: ListAction[];
  /** Import, export, sort, settings… behind «⋯». */
  more?: ListAction[];
}) {
  const t = useTranslations('list.actions');
  const dir = useDirection();
  return (
    <>
      {create &&
        (moreCreate.length ? (
          <ButtonGroup>
            <CreateButton create={create} />
            <DropdownMenu dir={dir}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  aria-label={t('moreCreate')}
                  className="border-s border-primary-foreground/30"
                >
                  <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {moreCreate.map((a) => (
                  <Item key={a.label} action={a} />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        ) : (
          <CreateButton create={create} />
        ))}
      {more.length > 0 && (
        <DropdownMenu dir={dir}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label={t('more')}>
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {more.map((a) => (
              <Item key={a.label} action={a} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function CreateButton({
  create,
}: {
  create: { label: string; onClick?: () => void; href?: string };
}) {
  return create.href ? (
    <Button asChild>
      <Link href={create.href}>
        <PlusIcon />
        {create.label}
      </Link>
    </Button>
  ) : (
    <Button onClick={create.onClick}>
      <PlusIcon />
      {create.label}
    </Button>
  );
}
