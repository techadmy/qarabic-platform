'use client';

import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Avatar, AvatarFallback } from '@qarabic/ui/components/avatar';
import { Badge } from '@qarabic/ui/components/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@qarabic/ui/components/breadcrumb';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@qarabic/ui/components/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Separator } from '@qarabic/ui/components/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@qarabic/ui/components/sheet';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';
import { AlertCircleIcon, ChevronDownIcon, InboxIcon, LanguagesIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { PasswordInput } from '@/components/auth/password-input';
import { EmptyState } from '@/components/states';
import { directionOf, isLocale } from '@/i18n/config';
import { useSwitchLocale } from '@/hooks/use-switch-locale';

/*
 * Sample copy below is fixed Arabic on purpose: this page checks Arabic RTL rendering and never
 * ships (404 in production builds).
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-start gap-4">{children}</CardContent>
    </Card>
  );
}

export function ComponentsPreview() {
  const t = useTranslations('dev');
  const locale = useLocale();
  const dir = directionOf(isLocale(locale) ? locale : 'ar');
  const { other, switchTo } = useSwitchLocale();

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-1 flex-col gap-1">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <Button variant="outline" onClick={() => switchTo(other)}>
          <LanguagesIcon />
          {other === 'en' ? 'English' : 'العربية'}
        </Button>
      </div>

      <Section title="Button / Spinner">
        <Button>حفظ التغييرات</Button>
        <Button variant="secondary">إلغاء</Button>
        <Button variant="outline">تصدير</Button>
        <Button variant="ghost">المزيد</Button>
        <Button variant="destructive">حذف</Button>
        <Button variant="link">عرض التفاصيل</Button>
        <Button disabled>
          <Spinner />
          جارٍ الحفظ…
        </Button>
      </Section>

      <Section title="Field / Input / Input Group / Checkbox">
        <div className="grid w-full gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="d-name">اسم الطالب</FieldLabel>
            <Input id="d-name" placeholder="مثال: عبد الله محمد" />
            <FieldDescription>يظهر الاسم في الجدول وفي التقارير.</FieldDescription>
          </Field>
          <Field data-invalid>
            <FieldLabel htmlFor="d-email">البريد الإلكتروني</FieldLabel>
            <Input id="d-email" dir="ltr" defaultValue="name@" aria-invalid />
            <FieldError>أدخل بريدًا إلكترونيًا صحيحًا</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="d-password">كلمة المرور</FieldLabel>
            <PasswordInput id="d-password" defaultValue="Qarabic-123" />
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="d-remember" defaultChecked />
            <FieldLabel htmlFor="d-remember" className="font-normal">
              تذكرني
            </FieldLabel>
          </Field>
        </div>
      </Section>

      <Section title="Alert">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircleIcon />
          <AlertTitle>تعذّر تسجيل الدخول</AlertTitle>
          <AlertDescription>البريد الإلكتروني أو كلمة المرور غير صحيحة.</AlertDescription>
        </Alert>
        <Alert className="max-w-md">
          <InboxIcon />
          <AlertTitle>أُرسل الرابط</AlertTitle>
          <AlertDescription>سيصلك رابط تغيير كلمة المرور خلال دقائق.</AlertDescription>
        </Alert>
      </Section>

      <Section title="Badge / Avatar / Skeleton / Separator">
        <Badge>منعقدة</Badge>
        <Badge variant="secondary">معدَّل</Badge>
        <Badge variant="outline">افتراضي</Badge>
        <Badge variant="destructive">غياب</Badge>
        <Avatar>
          <AvatarFallback>مع</AvatarFallback>
        </Avatar>
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
        <div className="flex h-5 items-center gap-3 text-sm">
          <span>الحصص</span>
          <Separator orientation="vertical" />
          <span>الجدول</span>
        </div>
      </Section>

      <Section title="Breadcrumb">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">الرئيسية</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">العائلات</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>عائلة أحمد</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Section>

      <Section title="Dropdown Menu / Tooltip / Sheet / Collapsible">
        <DropdownMenu dir={dir}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              الإجراءات
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>حسابي</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>تعديل</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>اللغة</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value="ar">
                  <DropdownMenuRadioItem value="ar">العربية</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">حذف</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline">مرِّر للتلميح</Button>
          </TooltipTrigger>
          <TooltipContent dir={dir}>تلميح قصير بالعربية</TooltipContent>
        </Tooltip>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">افتح اللوحة الجانبية</Button>
          </SheetTrigger>
          <SheetContent dir={dir} side={dir === 'rtl' ? 'left' : 'right'}>
            <SheetHeader>
              <SheetTitle>عوامل التصفية</SheetTitle>
              <SheetDescription>تفتح اللوحة من جهة نهاية السطر.</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
        <Collapsible className="w-64">
          <CollapsibleTrigger asChild>
            <Button variant="ghost">
              تفاصيل إضافية
              <ChevronDownIcon />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="p-2 text-sm">محتوى يظهر عند الفتح.</CollapsibleContent>
        </Collapsible>
      </Section>

      <Section title="Table (Data Table)">
        <Table aria-label="الأدوار">
          <TableHeader>
            <TableRow>
              <TableHead>الدور</TableHead>
              <TableHead>النوع</TableHead>
              <TableHead>الصلاحيات</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>مشرف متابعة</TableCell>
              <TableCell>موظفون</TableCell>
              <TableCell className="tabular-nums">42 صلاحية</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>معلم</TableCell>
              <TableCell>معلم</TableCell>
              <TableCell className="tabular-nums">16 صلاحية</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section title="Empty">
        <div className="w-full">
          <EmptyState
            icon={InboxIcon}
            title="لا توجد حصص اليوم"
            description="أنشئ جدولًا أسبوعيًا لتظهر الحصص هنا."
          />
        </div>
      </Section>
    </main>
  );
}
