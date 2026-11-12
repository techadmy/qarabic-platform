import { allowedSections, defaultSection, isSearchShortcut } from './sections';

describe('global search sections (D141 §5)', () => {
  const all = allowedSections([
    'families.view',
    'staff.view',
    'users.view',
    'leads.view',
    'invoices.view',
  ]);

  it('keeps only sections the user may view, in menu order', () => {
    expect(all).toEqual(['families', 'students', 'teachers', 'staff', 'leads', 'invoices']);
    expect(allowedSections(['leads.view'])).toEqual(['leads']);
    expect(allowedSections([])).toEqual([]);
  });

  it('scopes to the current section, else the first allowed one', () => {
    expect(defaultSection('/leads', all)).toBe('leads');
    expect(defaultSection('/leads/12', all)).toBe('leads');
    expect(defaultSection('/invoices/3', all)).toBe('invoices');
    expect(defaultSection('/today', all)).toBe('families');
    expect(defaultSection('/leadsx', all)).toBe('families');
    expect(defaultSection('/leads', ['families'])).toBe('families');
    expect(defaultSection('/', [])).toBeNull();
  });

  it('`/` opens it, except while typing or with a modifier', () => {
    const div = document.createElement('div');
    const input = document.createElement('input');
    const base = { ctrlKey: false, metaKey: false, altKey: false };
    expect(isSearchShortcut({ ...base, key: '/', target: div })).toBe(true);
    expect(isSearchShortcut({ ...base, key: '/', target: input })).toBe(false);
    expect(isSearchShortcut({ ...base, key: '/', ctrlKey: true, target: div })).toBe(false);
    expect(isSearchShortcut({ ...base, key: 'a', target: div })).toBe(false);
  });
});
