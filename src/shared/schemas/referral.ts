import { z } from 'zod';

/** 推广码：managerId UUID 的 base62 可逆短码。校验即解码，无法伪造。 */
export const ReferralCodeSchema = z.string().regex(/^[0-9a-zA-Z]{20,24}$/, '推广码格式不正确');

/** 分享行为流水（追加式审计，只增不改）。 */
export const ShareEventSchema = z.strictObject({
  id: z.uuid(),
  managerId: z.uuid(),
  sharerRole: z.enum(['manager', 'client']),
  sharerClientId: z.uuid().optional(),
  date: z.iso.date(),
  createdAt: z.date(),
});

/** 扫码自助注册输入。 */
export const RegisterInputSchema = z.strictObject({
  refCode: ReferralCodeSchema,
  username: z.string().trim().regex(/^[0-9a-zA-Z]{3,30}$/, '用户名须为 3-30 位字母或数字'),
  password: z.string().min(8).max(256),
  name: z.string().trim().min(1).max(80),
});

export type ReferralCode = z.infer<typeof ReferralCodeSchema>;
export type ShareEvent = z.infer<typeof ShareEventSchema>;
export type RegisterInput = z.infer<typeof RegisterInputSchema>;
