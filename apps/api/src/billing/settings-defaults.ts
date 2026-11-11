/**
 * Billing settings (Laravel `Settings::DEFAULTS['billing.*']`, docs/20, D85, D88, D140).
 * `GET/PUT /settings/billing`; spread into `SETTING_DEFAULTS`.
 */
export const BILLING_SETTING_DEFAULTS = {
  /** Class stages that count against a package (B24, D85): information on the invoice only. */
  'billing.deducting_stages': ['taken', 'absent', 'declined'] as string[],
  /** Reminder days relative to the due date (D88); `[]` = no automatic reminders. */
  'billing.reminder_days': [-3, 0, 3, 7] as number[],
  /** Due date of an issued invoice without one: N days after the issue date. */
  'billing.default_due_days': 7,
  /**
   * Invoice and reminder emails to parents (D140: no message to a real family). Off by default;
   * while off nothing is mailed to a family, automatic or manual.
   */
  'billing.notify_parents': false as boolean,
};
