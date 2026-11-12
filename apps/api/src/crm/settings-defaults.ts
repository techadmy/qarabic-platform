/**
 * CRM settings (Laravel `Settings::DEFAULTS['crm.*']`, docs/33 §3.2, D136, D137, D140).
 * `GET/PUT /settings/crm`; spread into `SETTING_DEFAULTS`.
 */
export const CRM_SETTING_DEFAULTS = {
  /** Automatic assignment of new web / referral leads (T1). */
  'crm.auto_assign_enabled': true as boolean,
  /** Roles in the round-robin pool (`[]` = every active user with `leads.manage`). */
  'crm.auto_assign_roles': ['csr'] as string[],
  /** D137: `any` = no shift limit (the lead waits for the owner's next shift). */
  'crm.shift_source': 'any' as 'any' | 'attendance' | 'hours',
  /** Fallback owner when the pool is empty (0 = none: the `leads.assign` holders are told). */
  'crm.lead_admin_user_id': 0,
  /** First-response SLA (B84), counted in working minutes only. */
  'crm.first_response_minutes': 30,
  'crm.working_hours_start': '10:00',
  'crm.working_hours_end': '22:00',
  'crm.working_hours_timezone': 'Africa/Cairo',
  /** Unanswered contact attempts after which the workbench suggests «لا يرد». */
  'crm.unanswered_attempts_suggest_lost': 3,
  /** D140: no message to a family until Ahmed approves it (Laravel default was on for the app form). */
  'crm.trial_form_confirmation': false as boolean,
  'crm.web_lead_confirmation': false as boolean,
};
