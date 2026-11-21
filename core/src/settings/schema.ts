import { z } from 'zod';

export const settingsSchema = z.object({
  inboundPlatform: z.enum(['qq', 'telegram']),
  inboundRingTimeoutSec: z.number().positive().refine(Number.isInteger),
  outboundUserAnswerTimeoutSec: z.number().positive().refine(Number.isInteger),
  outboundCalleeAnswerTimeoutSec: z.number().positive().refine(Number.isInteger),
  outboundCallbackRingTimeoutSec: z.number().positive().refine(Number.isInteger),
  smsForward: z.boolean(),
  smsRatePerMin: z.number().positive().refine(Number.isInteger).nullable(),
  defaultDeviceId: z.string().regex(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/).nullable(),
  botLocale: z.enum(['zh-CN', 'zh-HK', 'en']),
  heartbeatSec: z.number().positive().max(86400).refine(Number.isInteger),
  offlineAfterSec: z.number().positive().refine(Number.isInteger),
  alertPushIntervalSec: z.number().positive().refine(Number.isInteger),
  earlyMediaThresholdDbfs: z.number().finite(),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial().refine(value => Object.keys(value).length > 0);
export type SettingsPatch = Partial<Settings>;
// Validate raw own keys before Zod normalizes objects (notably __proto__).
export const conditionalSettingsSchema = z.unknown().refine(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return [body.changes, body.expected].every(part => part !== null && typeof part === 'object' && !Array.isArray(part) && Object.keys(part).every(key => Object.prototype.hasOwnProperty.call(settingsSchema.shape, key)));
}).pipe(z.object({ changes: settingsPatchSchema, expected: settingsPatchSchema }).strict().refine(({changes, expected}) => {
  const keys = Object.keys(changes);
  return keys.length === Object.keys(expected).length && keys.every(key => Object.prototype.hasOwnProperty.call(expected, key) && changes[key as keyof Settings] !== undefined && expected[key as keyof Settings] !== undefined);
}));
