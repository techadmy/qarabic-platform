import { cn } from '@qarabic/ui/lib/utils';

/** The `cn` helper knows the Qarabic font-size tokens (`--text-body`, `--text-caption`). */
describe('cn with the type-scale tokens', () => {
  it('keeps a size token next to a text colour', () => {
    expect(cn('text-caption text-muted-foreground')).toBe('text-caption text-muted-foreground');
    expect(cn('text-body', 'text-status-green-foreground')).toBe(
      'text-body text-status-green-foreground',
    );
  });

  it('lets a later size win, as with the built-in sizes', () => {
    expect(cn('text-sm', 'text-caption')).toBe('text-caption');
    expect(cn('text-caption', 'text-body')).toBe('text-body');
    expect(cn('md:text-sm', 'md:text-body')).toBe('md:text-body');
  });

  it('still merges colours with each other', () => {
    expect(cn('text-caption text-foreground', 'text-muted-foreground')).toBe(
      'text-caption text-muted-foreground',
    );
  });
});
