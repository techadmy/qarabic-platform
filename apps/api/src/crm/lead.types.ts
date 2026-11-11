import type { LeadSource } from '@qarabic/shared';

/** A child as the lead keeps it (`leads.children`, JSON). */
export interface LeadChild {
  name?: string;
  age?: number;
  gender?: 'male' | 'female';
  courseId?: number;
}

/** Normalised intake fields (public forms, referrals, the website webhook, staff). */
export interface IntakeData {
  parentName?: string | null;
  email?: string | null;
  phone?: string | null;
  countryCode?: string | null;
  city?: string | null;
  timezone?: string | null;
  preferredLanguage?: string | null;
  /** Cleaned by `LeadService.normalise` (blank values dropped). */
  children?: Array<{
    name?: string | null;
    age?: number | null;
    gender?: 'male' | 'female' | null;
    courseId?: number | null;
  }>;
  courseInterest?: string | null;
  preferredTimes?: string | null;
  preferredSchedule?: { days?: number[]; periods?: string[]; note?: string } | null;
  teacherGenderPref?: string | null;
  heardFrom?: string | null;
  message?: string | null;
  site?: string | null;
  utm?: Record<string, string> | null;
  source?: LeadSource;
  referralFamilyId?: number | null;
  externalRef?: string | null;
}
