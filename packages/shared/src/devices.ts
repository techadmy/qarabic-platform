import { z } from 'zod';

/**
 * Mobile readiness (docs/17 §5): the signed-in person's devices for push notifications.
 * `/api/v1/me/devices`. A token belongs to one person at a time: registering it again (same phone,
 * another account) moves it. Unregister on sign-out.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

export const DEVICE_PLATFORMS = ['ios', 'android', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export const DEVICE_PLATFORM_LABELS: Labels<DevicePlatform> = {
  ios: { ar: 'iOS', en: 'iOS' },
  android: { ar: 'أندرويد', en: 'Android' },
  web: { ar: 'متصفح', en: 'Browser' },
};

export const registerDeviceSchema = z.object({
  /** The push token from FCM (or Expo). */
  token: z
    .string()
    .trim()
    .min(16)
    .max(512)
    .regex(/^[\x21-\x7e]+$/, { message: 'Use the token as given by the push service.' }),
  platform: z.enum(DEVICE_PLATFORMS),
  appVersion: z.string().trim().max(32).nullish(),
  deviceName: z.string().trim().max(80).nullish(),
});
export type RegisterDeviceInput = z.input<typeof registerDeviceSchema>;

export const deviceSchema = z.object({
  id: z.number().int().positive(),
  platform: z.enum(DEVICE_PLATFORMS),
  appVersion: z.string().nullable(),
  deviceName: z.string().nullable(),
  /** Last registration or refresh. */
  lastSeenAt: z.string(),
  createdAt: z.string(),
});
export type DeviceDto = z.infer<typeof deviceSchema>;
