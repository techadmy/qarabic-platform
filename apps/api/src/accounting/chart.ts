import type { AccountType, SystemAccountKey } from '@qarabic/shared';

/**
 * The seeded chart of accounts (docs/07 §أ.2: the old 11 categories and their heads, reviewed for a
 * real double-entry ledger, plus the accounts the automatic entries need). Groups are headings;
 * only the leaves are posted to. The migration `m7_accounting` inserts exactly these rows (a unit
 * test checks they agree); the e2e reset re-seeds them with {@link seedChart}.
 */
export interface ChartRow {
  code: string;
  parent: string | null;
  type: AccountType;
  nameAr: string;
  nameEn: string;
  group?: true;
  cash?: true;
  key?: SystemAccountKey;
}

// prettier-ignore
export const CHART: readonly ChartRow[] = [
  { code: '1', parent: null, type: 'asset', group: true, nameAr: 'الأصول', nameEn: 'Assets' },
  { code: '11', parent: '1', type: 'asset', group: true, nameAr: 'النقدية والبنوك', nameEn: 'Cash and bank' },
  { code: '1110', parent: '11', type: 'asset', cash: true, key: 'cash', nameAr: 'النقدية بالصندوق', nameEn: 'Cash in hand' },
  { code: '1120', parent: '11', type: 'asset', cash: true, key: 'bank', nameAr: 'البنك', nameEn: 'Bank' },
  { code: '1130', parent: '11', type: 'asset', cash: true, key: 'stripe_clearing', nameAr: 'حساب تسوية Stripe', nameEn: 'Stripe clearing' },
  { code: '1140', parent: '11', type: 'asset', cash: true, key: 'paypal_clearing', nameAr: 'حساب تسوية PayPal', nameEn: 'PayPal clearing' },
  { code: '1150', parent: '11', type: 'asset', cash: true, key: 'vodafone_cash', nameAr: 'محفظة فودافون كاش', nameEn: 'Vodafone Cash wallet' },
  { code: '12', parent: '1', type: 'asset', group: true, nameAr: 'الذمم المدينة', nameEn: 'Receivables' },
  { code: '1210', parent: '12', type: 'asset', key: 'receivable', nameAr: 'ذمم أولياء الأمور (الرسوم الدراسية)', nameEn: 'Tuition receivable' },
  { code: '13', parent: '1', type: 'asset', group: true, nameAr: 'السلف والمصروفات المدفوعة مقدمًا', nameEn: 'Advances and prepayments' },
  { code: '1310', parent: '13', type: 'asset', key: 'staff_advances', nameAr: 'سلف المعلمين والموظفين', nameEn: 'Staff advances' },
  { code: '1320', parent: '13', type: 'asset', nameAr: 'مصروفات مدفوعة مقدمًا', nameEn: 'Prepaid expenses' },
  { code: '14', parent: '1', type: 'asset', group: true, nameAr: 'الأصول الثابتة الملموسة', nameEn: 'Tangible assets' },
  { code: '1410', parent: '14', type: 'asset', nameAr: 'الأثاث', nameEn: 'Furniture' },
  { code: '1420', parent: '14', type: 'asset', nameAr: 'الأجهزة الكهربائية', nameEn: 'Electrical equipment' },
  { code: '1430', parent: '14', type: 'asset', nameAr: 'المعدات المكتبية', nameEn: 'Office equipment' },
  { code: '1440', parent: '14', type: 'asset', nameAr: 'أجهزة الحاسب', nameEn: 'Computers' },
  { code: '1490', parent: '14', type: 'asset', nameAr: 'مجمع الإهلاك', nameEn: 'Accumulated depreciation' },
  { code: '15', parent: '1', type: 'asset', group: true, nameAr: 'الأصول غير الملموسة', nameEn: 'Intangible assets' },
  { code: '1510', parent: '15', type: 'asset', nameAr: 'البرمجيات', nameEn: 'Software' },
  { code: '1520', parent: '15', type: 'asset', nameAr: 'استضافة الموقع', nameEn: 'Website hosting' },
  { code: '1530', parent: '15', type: 'asset', nameAr: 'الشهرة', nameEn: 'Goodwill' },
  { code: '1590', parent: '15', type: 'asset', nameAr: 'مجمع الاستهلاك', nameEn: 'Accumulated amortization' },

  { code: '2', parent: null, type: 'liability', group: true, nameAr: 'الخصوم', nameEn: 'Liabilities' },
  { code: '21', parent: '2', type: 'liability', group: true, nameAr: 'المصروفات المستحقة', nameEn: 'Accrued expenses' },
  { code: '2110', parent: '21', type: 'liability', key: 'salaries_payable', nameAr: 'رواتب مستحقة (محافظ المعلمين)', nameEn: 'Salaries payable (teacher wallets)' },
  { code: '2120', parent: '21', type: 'liability', nameAr: 'مرافق مستحقة', nameEn: 'Utilities payable' },
  { code: '2130', parent: '21', type: 'liability', nameAr: 'دائنون آخرون', nameEn: 'Other payables' },
  { code: '22', parent: '2', type: 'liability', group: true, nameAr: 'الضرائب', nameEn: 'Taxes' },
  { code: '2210', parent: '22', type: 'liability', key: 'tax_payable', nameAr: 'ضرائب مستحقة', nameEn: 'Tax payable' },
  { code: '23', parent: '2', type: 'liability', group: true, nameAr: 'القروض طويلة الأجل', nameEn: 'Long-term loans' },
  { code: '2310', parent: '23', type: 'liability', nameAr: 'قرض', nameEn: 'Loan' },

  { code: '3', parent: null, type: 'equity', group: true, nameAr: 'حقوق الملكية', nameEn: 'Equity' },
  { code: '3100', parent: '3', type: 'equity', nameAr: 'رأس المال', nameEn: "Owner's capital" },
  { code: '3150', parent: '3', type: 'equity', nameAr: 'المسحوبات الشخصية', nameEn: "Owner's drawings" },
  { code: '3200', parent: '3', type: 'equity', key: 'retained_earnings', nameAr: 'الأرباح المحتجزة', nameEn: 'Retained earnings' },
  { code: '3300', parent: '3', type: 'equity', key: 'opening_balance', nameAr: 'أرصدة افتتاحية', nameEn: 'Opening balance equity' },

  { code: '4', parent: null, type: 'income', group: true, nameAr: 'الإيرادات', nameEn: 'Income' },
  { code: '4100', parent: '4', type: 'income', key: 'tuition_revenue', nameAr: 'إيرادات الرسوم الدراسية', nameEn: 'Tuition fees' },
  { code: '4150', parent: '4', type: 'income', key: 'discounts', nameAr: 'خصومات مسموح بها', nameEn: 'Discounts allowed' },
  { code: '4200', parent: '4', type: 'income', key: 'fines_income', nameAr: 'إيرادات الجزاءات', nameEn: 'Fines income' },
  { code: '4900', parent: '4', type: 'income', nameAr: 'إيرادات أخرى', nameEn: 'Other income' },

  { code: '5', parent: null, type: 'expense', group: true, nameAr: 'المصروفات', nameEn: 'Expenses' },
  { code: '51', parent: '5', type: 'expense', group: true, nameAr: 'تكلفة الخدمات', nameEn: 'Cost of services' },
  { code: '5110', parent: '51', type: 'expense', key: 'salaries_expense', nameAr: 'رواتب المعلمين', nameEn: 'Teacher salaries' },
  { code: '5120', parent: '51', type: 'expense', nameAr: 'مكافآت المديرين', nameEn: "Directors' remuneration" },
  { code: '5130', parent: '51', type: 'expense', nameAr: 'الإيجار', nameEn: 'Rent' },
  { code: '5140', parent: '51', type: 'expense', nameAr: 'الكهرباء', nameEn: 'Electricity' },
  { code: '5150', parent: '51', type: 'expense', nameAr: 'الإنترنت', nameEn: 'Internet' },
  { code: '5160', parent: '51', type: 'expense', nameAr: 'سماعات الرأس', nameEn: 'Headphones' },
  { code: '5170', parent: '51', type: 'expense', nameAr: 'التدريب', nameEn: 'Training' },
  { code: '5180', parent: '51', type: 'expense', nameAr: 'الإهلاك', nameEn: 'Depreciation' },
  { code: '5190', parent: '51', type: 'expense', nameAr: 'الاستهلاك', nameEn: 'Amortization' },
  { code: '52', parent: '5', type: 'expense', group: true, nameAr: 'المصروفات الإدارية والعمومية', nameEn: 'Administrative and general' },
  { code: '5210', parent: '52', type: 'expense', nameAr: 'رواتب الموظفين الإداريين', nameEn: 'Administrative salaries' },
  { code: '5215', parent: '52', type: 'expense', nameAr: 'الطباعة والأدوات المكتبية', nameEn: 'Printing and stationery' },
  { code: '5220', parent: '52', type: 'expense', nameAr: 'الأتعاب القانونية', nameEn: 'Legal fees' },
  { code: '5225', parent: '52', type: 'expense', nameAr: 'الدعاية والإعلان', nameEn: 'Advertising' },
  { code: '5230', parent: '52', type: 'expense', nameAr: 'الهاتف', nameEn: 'Telephone' },
  { code: '5235', parent: '52', type: 'expense', nameAr: 'الوقود', nameEn: 'Fuel' },
  { code: '5240', parent: '52', type: 'expense', nameAr: 'الإصلاح والصيانة', nameEn: 'Repairs and maintenance' },
  { code: '5245', parent: '52', type: 'expense', nameAr: 'الأمن', nameEn: 'Security' },
  { code: '5250', parent: '52', type: 'expense', nameAr: 'الغاز', nameEn: 'Gas' },
  { code: '5255', parent: '52', type: 'expense', nameAr: 'المياه', nameEn: 'Water' },
  { code: '5260', parent: '52', type: 'expense', nameAr: 'السفر والانتقالات', nameEn: 'Travel' },
  { code: '5265', parent: '52', type: 'expense', nameAr: 'البريد السريع', nameEn: 'Courier' },
  { code: '5270', parent: '52', type: 'expense', nameAr: 'النظافة', nameEn: 'Cleaning' },
  { code: '5275', parent: '52', type: 'expense', nameAr: 'أتعاب المراجعة', nameEn: 'Audit fees' },
  { code: '5280', parent: '52', type: 'expense', key: 'gateway_fees', nameAr: 'عمولات بوابات الدفع', nameEn: 'Payment gateway fees' },
  { code: '53', parent: '5', type: 'expense', group: true, nameAr: 'المصروفات البنكية', nameEn: 'Bank charges' },
  { code: '5310', parent: '53', type: 'expense', nameAr: 'الفوائد', nameEn: 'Interest' },
  { code: '5320', parent: '53', type: 'expense', nameAr: 'مصروفات بنكية أخرى', nameEn: 'Other bank charges' },
  { code: '54', parent: '5', type: 'expense', group: true, nameAr: 'الضرائب', nameEn: 'Tax' },
  { code: '5410', parent: '54', type: 'expense', nameAr: 'ضريبة الدخل', nameEn: 'Income tax' },
  // P1-1 (B115): added later, so it is last (ids follow this order); a migration adds it in place.
  { code: '2140', parent: '21', type: 'liability', key: 'customer_credits', nameAr: 'أرصدة دائنة للعملاء (مدفوعات زائدة)', nameEn: 'Customer credits (overpayments)' },
];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The seed as SQL statements (one `INSERT` with fixed ids, then the id sequence), for the migration. */
export function chartStatements(rows: readonly (typeof CHART)[number][] = CHART): string[] {
  const ids = new Map(rows.map((r, i) => [r.code, i + 1]));
  const values = rows.map(
    (r, i) =>
      `(${i + 1}, ${q(r.code)}, ${q(r.nameAr)}, ${q(r.nameEn)}, ${q(r.type)}, ` +
      `${r.parent ? ids.get(r.parent) : 'NULL'}, ${r.group ? 'true' : 'false'}, ` +
      `${r.cash ? 'true' : 'false'}, ${r.key ? q(r.key) : 'NULL'})`,
  );
  return [
    `INSERT INTO "ledger_accounts" ("id", "code", "name_ar", "name_en", "type", "parent_id", "is_group", "is_cash", "system_key") VALUES\n  ${values.join(',\n  ')};`,
    `SELECT setval(pg_get_serial_sequence('"ledger_accounts"', 'id'), ${rows.length});`,
  ];
}

type Db = {
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRawUnsafe(sql: string): Promise<unknown>;
};

/** Inserts the chart into an empty `ledger_accounts` (the e2e reset, fresh dev databases). */
export async function seedChart(db: Db): Promise<void> {
  const [insert, sequence] = chartStatements();
  await db.$executeRawUnsafe(insert!);
  await db.$queryRawUnsafe(sequence!);
}
