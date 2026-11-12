import { createCn } from 'cn/config';

/**
 * clsx + tailwind-merge (shadcn `cn`), taught the Qarabic font-size tokens: without this,
 * `text-caption text-muted-foreground` would be read as two text colours and `text-caption`
 * dropped. Add any new `--text-*` token here too.
 */
export const cn = createCn({
  extend: { classGroups: { 'font-size': [{ text: ['body', 'caption'] }] } },
});
