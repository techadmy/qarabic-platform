'use client';

import { Checkbox } from '@qarabic/ui/components/checkbox';
import { Label } from '@qarabic/ui/components/label';
import { cn } from '@qarabic/ui/lib/utils';
import { LockIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { MatrixGroup } from '@/lib/roles/matrix';
import { toggleModule, togglePermission } from '@/lib/roles/matrix';

/**
 * The permission matrix (docs/29 §3): groups in sidebar order, one row per module with an Arabic
 * module name and a «الكل» toggle, one shadcn `Checkbox` per action with its short hint. Cells the
 * viewer cannot grant are disabled and say why (lock + text), never silently.
 */
export function PermissionMatrix({
  groups,
  value,
  onChange,
  grantable,
  readOnly,
  search,
}: {
  groups: MatrixGroup[];
  value: string[];
  onChange: (next: string[]) => void;
  grantable: (permission: string) => boolean;
  readOnly: boolean;
  search: string;
}) {
  const t = useTranslations('roles.editor');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const q = search.trim().toLowerCase();
  const selected = new Set(value);

  const visible = groups
    .map((g) => ({
      ...g,
      modules: g.modules.filter(
        (m) =>
          !q ||
          [
            m.labelAr,
            m.labelEn,
            m.module,
            ...m.actions.flatMap((a) => [a.labelAr, a.labelEn, a.hintAr, a.hintEn]),
          ]
            .join(' ')
            .toLowerCase()
            .includes(q),
      ),
    }))
    .filter((g) => g.modules.length);

  if (!visible.length) {
    return (
      <p className="py-6 text-center text-muted-foreground">{t('noMatch', { query: search })}</p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {visible.map((group) => {
        const perms = group.modules.flatMap((m) => m.actions.map((a) => a.permission));
        const count = perms.filter((p) => selected.has(p)).length;
        const groupId = `group-${group.group}`;
        return (
          <section key={group.group} aria-labelledby={groupId} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id={groupId} className="text-base font-bold">
                {locale === 'ar' ? group.labelAr : group.labelEn}
              </h3>
              <span className="text-sm text-muted-foreground tabular-nums">
                {t('groupCount', { count, total: perms.length })}
              </span>
            </div>
            <div className="divide-y rounded-lg border">
              {group.modules.map((m) => {
                const modulePerms = m.actions.map((a) => a.permission);
                const on = modulePerms.filter((p) => selected.has(p)).length;
                const allState =
                  on === 0 ? false : on === modulePerms.length ? true : 'indeterminate';
                const anyGrantable = !readOnly && modulePerms.some(grantable);
                const moduleLabel = locale === 'ar' ? m.labelAr : m.labelEn;
                const allId = `all-${m.module}`;
                return (
                  <div
                    key={m.module}
                    role="group"
                    aria-label={moduleLabel}
                    className="grid gap-3 p-3 md:grid-cols-[13rem_1fr] md:gap-4"
                  >
                    <div className="flex flex-col gap-2">
                      <span className="font-semibold">{moduleLabel}</span>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={allId}
                          checked={allState}
                          disabled={!anyGrantable}
                          onCheckedChange={(checked) =>
                            onChange(toggleModule(value, modulePerms, checked === true, grantable))
                          }
                          aria-label={t('allOf', { module: moduleLabel })}
                        />
                        <Label htmlFor={allId} className="font-normal" aria-hidden>
                          {t('all')}
                        </Label>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {m.actions.map((a) => {
                        const id = `perm-${a.permission}`;
                        const can = !readOnly && grantable(a.permission);
                        const notHeld = !readOnly && !grantable(a.permission);
                        return (
                          <div key={a.permission} className="flex items-start gap-2">
                            <Checkbox
                              id={id}
                              className="mt-0.5"
                              checked={selected.has(a.permission)}
                              disabled={!can}
                              onCheckedChange={(checked) =>
                                onChange(togglePermission(value, a.permission, checked === true))
                              }
                              aria-describedby={`${id}-hint`}
                            />
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <Label
                                htmlFor={id}
                                className={cn('font-medium', !can && 'text-muted-foreground')}
                              >
                                {locale === 'ar' ? a.labelAr : a.labelEn}
                                <span className="sr-only"> ({moduleLabel})</span>
                              </Label>
                              <span id={`${id}-hint`} className="text-xs text-muted-foreground">
                                {locale === 'ar' ? a.hintAr : a.hintEn}
                                {notHeld && (
                                  <span className="mt-0.5 flex items-center gap-1 text-foreground/70">
                                    <LockIcon className="size-3" aria-hidden />
                                    {t('notHeld')}
                                  </span>
                                )}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
