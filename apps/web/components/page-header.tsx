import type { ReactNode } from 'react';

/** Page title (one h1 per page) + optional description and count (docs/15 §5.2). */
export function PageHeader({
  title,
  description,
  meta,
}: {
  title: string;
  description?: string;
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-bold tracking-normal">{title}</h1>
      {description && <p className="text-muted-foreground">{description}</p>}
      {meta && <p className="text-sm text-muted-foreground">{meta}</p>}
    </div>
  );
}
