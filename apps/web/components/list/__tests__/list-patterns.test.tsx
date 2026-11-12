import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ColumnDef } from '@tanstack/react-table';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from '@/components/data-table';
import { CollapsibleSummary } from '@/components/list/collapsible-summary';
import { useColumnVisibility } from '@/components/list/column-chooser';
import { ListActions } from '@/components/list/list-actions';
import { SplitList, SplitView } from '@/components/list/split-view';
import { ViewsMenu } from '@/components/list/views-menu';
import { PageHeader } from '@/components/page-header';
import { renderWithProviders } from '@/test/render';

/** D141 list patterns: shared components, Arabic and English. */
afterEach(() => window.localStorage.clear());

type Row = { id: number; name: string; city: string; phone: string };
const ROWS: Row[] = [
  { id: 1, name: 'Amina', city: 'Cairo', phone: '+20 100' },
  { id: 2, name: 'Yusuf', city: 'Dubai', phone: '+971 50' },
];
const COLUMNS: ColumnDef<Row, unknown>[] = [
  { id: 'name', header: 'الاسم', enableHiding: false, cell: ({ row }) => row.original.name },
  { id: 'city', header: 'المدينة', cell: ({ row }) => row.original.city },
  { id: 'phone', header: 'الهاتف', cell: ({ row }) => row.original.phone },
];

function Table() {
  const [visibility, setVisibility] = useColumnVisibility('test:1');
  return (
    <DataTable
      columns={COLUMNS}
      data={ROWS}
      label="القائمة"
      emptyText="لا شيء"
      columnVisibility={visibility}
      onColumnVisibilityChange={setVisibility}
    />
  );
}

describe('ColumnChooser', () => {
  it('hides a column, keeps the fixed one, remembers the choice and shows all again', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<Table />);
    const table = screen.getByRole('table', { name: 'القائمة' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'اختيار الأعمدة' }));
    const menu = await screen.findByRole('menu');
    // The record name cannot be hidden.
    expect(within(menu).queryByRole('menuitemcheckbox', { name: 'الاسم' })).toBeNull();
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'المدينة' }));
    // The menu stays open to pick several columns.
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'المدينة' })).not.toBeChecked();
    await user.keyboard('{Escape}');
    expect(within(table).queryByRole('columnheader', { name: 'المدينة' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('qarabic.columns.test:1')!)).toEqual({
      city: false,
    });
    unmount();

    renderWithProviders(<Table />);
    const again = screen.getByRole('table', { name: 'القائمة' });
    expect(await within(again).findAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /اختيار الأعمدة/ })).toHaveTextContent(
      'عمود واحد مخفي',
    );
    await user.click(screen.getByRole('button', { name: /اختيار الأعمدة/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'إظهار كل الأعمدة' }));
    expect(within(again).getAllByRole('columnheader')).toHaveLength(4);
  });

  it('still works when storage throws', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    renderWithProviders(<Table />);
    await user.click(screen.getByRole('button', { name: 'اختيار الأعمدة' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'الهاتف' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('columnheader', { name: 'الهاتف' })).toBeNull();
    spy.mockRestore();
  });
});

describe('ViewsMenu', () => {
  function Views({ locale }: { locale: 'ar' | 'en' }) {
    const [value, setValue] = useState('open');
    return (
      <PageHeader
        title={
          <ViewsMenu
            title={locale === 'ar' ? 'العملاء' : 'Leads'}
            label={locale === 'ar' ? 'تصفية حسب الحالة' : 'Filter by status'}
            value={value}
            onChange={setValue}
            options={[
              { value: 'open', label: locale === 'ar' ? 'المفتوحة' : 'Open', count: 8 },
              { value: 'new', label: locale === 'ar' ? 'جديد' : 'New', count: 4 },
            ]}
          />
        }
      />
    );
  }

  it('is part of the h1 and switches the view from the keyboard (Arabic)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Views locale="ar" />);
    const h1 = screen.getByRole('heading', { level: 1 });
    const trigger = within(h1).getByRole('button', { name: /^المفتوحة\s*\(8\)\s*تغيير العرض$/ });
    trigger.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('تصفية حسب الحالة')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(
      within(h1).getByRole('button', { name: /^جديد\s*\(4\)\s*تغيير العرض$/ }),
    ).toBeInTheDocument();
  });

  it('reads in English', async () => {
    renderWithProviders(<Views locale="en" />, { locale: 'en' });
    expect(
      screen.getByRole('button', { name: /^Open\s*\(8\)\s*Change view$/ }),
    ).toBeInTheDocument();
  });
});

describe('ListActions', () => {
  it('shows the split New button with the other create actions, and «⋯»', async () => {
    const user = userEvent.setup();
    const create = vi.fn();
    const importIt = vi.fn();
    renderWithProviders(
      <ListActions
        create={{ label: 'جديد', onClick: create }}
        moreCreate={[{ label: 'فاتورة من قالب', onSelect: vi.fn() }]}
        more={[
          { label: 'استيراد', onSelect: importIt },
          { label: 'الإعدادات', href: '/settings' },
        ]}
      />,
    );
    expect(screen.getByRole('group')).toContainElement(
      screen.getByRole('button', { name: 'جديد' }),
    );
    await user.click(screen.getByRole('button', { name: 'جديد' }));
    expect(create).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'إجراءات إنشاء أخرى' }));
    expect(await screen.findByRole('menuitem', { name: 'فاتورة من قالب' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'إجراءات أخرى' }));
    expect(await screen.findByRole('menuitem', { name: 'الإعدادات' })).toHaveAttribute(
      'href',
      '/settings',
    );
    await user.click(screen.getByRole('menuitem', { name: 'استيراد' }));
    expect(importIt).toHaveBeenCalled();
  });

  it('renders a plain button without other create actions, and nothing when empty', () => {
    const { unmount } = renderWithProviders(<ListActions />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    renderWithProviders(<ListActions create={{ label: 'جديد', onClick: vi.fn() }} />);
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('button', { name: 'جديد' })).toBeInTheDocument();
  });
});

describe('CollapsibleSummary', () => {
  it('is closed by default, shows the hint, opens and remembers it', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(
      <CollapsibleSummary storageKey="test:1" hint="3 بلا تواصل">
        <p>الأرقام</p>
      </CollapsibleSummary>,
    );
    expect(screen.queryByText('الأرقام')).toBeNull();
    expect(screen.getByText('3 بلا تواصل')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: /ملخص.*إظهار التفاصيل/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(screen.getByText('الأرقام')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إخفاء التفاصيل/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    unmount();
    renderWithProviders(
      <CollapsibleSummary storageKey="test:1">
        <p>الأرقام</p>
      </CollapsibleSummary>,
    );
    expect(await screen.findByText('الأرقام')).toBeInTheDocument();
  });
});

describe('SplitView', () => {
  it('lists the rows with the open one marked, and the record header becomes h2 + close', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <>
        <PageHeader title="العملاء" />
        <SplitView
          selectedId="2"
          wide
          detailLabel="تفاصيل العميل"
          onClose={onClose}
          fullHref="/leads/2"
          list={
            <SplitList
              rows={ROWS}
              label="العملاء"
              emptyText="لا شيء"
              getRowId={(r) => r.id}
              hrefFor={(id) => `/leads?id=${id}`}
              selectedId="2"
              renderItem={(r) => r.name}
            />
          }
          detail={<PageHeader title="Yusuf" back={{ href: '/leads', label: 'رجوع' }} />}
        />
      </>,
    );
    const list = screen.getByRole('list', { name: 'العملاء' });
    expect(within(list).getByRole('link', { name: 'Yusuf' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(list).getByRole('link', { name: 'Amina' })).toHaveAttribute(
      'href',
      '/leads?id=1',
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const detail = screen.getByRole('region', { name: 'تفاصيل العميل' });
    expect(detail).toHaveFocus();
    expect(within(detail).getByRole('heading', { level: 2, name: 'Yusuf' })).toBeInTheDocument();
    expect(within(detail).queryByRole('link', { name: 'رجوع' })).toBeNull();
    expect(within(detail).getByRole('link', { name: 'فتح في صفحة كاملة' })).toHaveAttribute(
      'href',
      '/leads/2',
    );
    await user.click(within(detail).getByRole('button', { name: 'إغلاق والعودة إلى القائمة' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows only the record on a narrow screen', () => {
    renderWithProviders(
      <SplitView
        selectedId="2"
        wide={false}
        detailLabel="تفاصيل العميل"
        onClose={vi.fn()}
        fullHref="/leads/2"
        list={<p>القائمة</p>}
        detail={<p>السجل</p>}
      />,
    );
    expect(screen.queryByText('القائمة')).toBeNull();
    expect(screen.getByText('السجل')).toBeInTheDocument();
  });
});
