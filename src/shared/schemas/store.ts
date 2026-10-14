import { z } from 'zod';
import { NonnegativeMonetaryAmountSchema } from './money.ts';

const NameSchema = z.string().trim().min(1).max(100);

/** 微信号（wechat-bind 模块）：非必填文本，仅长度与非空白校验（微信账号规则不公开）。 */
export const WechatSchema = z.string().trim().min(1).max(40, '微信号不能超过 40 个字符');

export const StoreSchema = z.strictObject({
  id: z.uuid(),
  name: NameSchema,
  address: z.string().trim().max(500).default(''),
});

export const StoreManagerSchema = z.strictObject({
  id: z.uuid(), storeId: z.uuid(), name: NameSchema,
  wechat: WechatSchema.optional(),
});

export const ClientSchema = z.strictObject({
  id: z.uuid(), storeId: z.uuid(), name: z.string().trim().min(1).max(80),
  managerId: z.uuid().optional(),
  introducedByClientId: z.uuid().optional(),
  wechat: WechatSchema.optional(),
  reconciliationBalance: NonnegativeMonetaryAmountSchema.default(0),
  createdDate: z.iso.date().optional(),
});

export const ClientAttributionAuditSchema = z.strictObject({
  id: z.uuid(), clientId: z.uuid(), storeId: z.uuid(), managerId: z.uuid(),
  eventType: z.enum(['Created', 'Migrated']).default('Created'),
  introducedByClientId: z.uuid().optional(),
  date: z.iso.date(),
  note: z.string().trim().min(1).max(200),
  createdAt: z.date(),
});

export type Store = z.infer<typeof StoreSchema>;
export type StoreManager = z.infer<typeof StoreManagerSchema>;
export type Client = z.infer<typeof ClientSchema>;
export type ClientAttributionAudit = z.infer<typeof ClientAttributionAuditSchema>;
