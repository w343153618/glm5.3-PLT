/**
 * lucky — 客户幸运号收藏（pick-assist 模块）。
 * 每客户最多 10 个 3 位数字号码；clientId+code 幂等；仅归属客户本人可操作。
 * 存储：records 表 kind='lucky_code'，id=`${clientId}:${code}`。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../../shared/database.ts';
import { DomainError } from '../../shared/errors.ts';

export const LuckyCodeSchema = z.strictObject({
  id: z.string().min(1),
  clientId: z.string().min(1),
  code: z.string().regex(/^[0-9]{3}$/, '号码须为 3 位数字'),
  createdAt: z.date(),
});
export type LuckyCode = z.infer<typeof LuckyCodeSchema>;

const MAX_LUCKY_CODES = 10;

export function createLuckyModule(db: AppDatabase) {
  function list(clientId: string): LuckyCode[] {
    return db.list('lucky_code')
      .map(item => LuckyCodeSchema.parse(item))
      .filter(entry => entry.clientId === clientId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  /** 保存（幂等）：同 client 同 code 已存在时返回既有记录。超上限抛 400。 */
  function save(clientId: string, rawCode: unknown): LuckyCode {
    const code = String(rawCode ?? '');
    if (!/^[0-9]{3}$/.test(code)) throw new DomainError('号码须为 3 位数字', 400);
    const id = `${clientId}:${code}`;
    const existing = db.get('lucky_code', id);
    if (existing !== undefined) return LuckyCodeSchema.parse(existing);
    if (list(clientId).length >= MAX_LUCKY_CODES) {
      throw new DomainError(`最多收藏 ${MAX_LUCKY_CODES} 个幸运号，请先删除部分`, 400);
    }
    const entry: LuckyCode = { id, clientId, code, createdAt: new Date() };
    db.transaction(() => {
      const raced = db.get('lucky_code', id);
      if (raced === undefined) db.insert('lucky_code', id, entry);
    });
    return LuckyCodeSchema.parse(db.get('lucky_code', id));
  }

  /** 删除：不存在或归属他人均抛 404/403。 */
  function remove(clientId: string, rawCode: unknown): void {
    const code = String(rawCode ?? '');
    if (!/^[0-9]{3}$/.test(code)) throw new DomainError('号码须为 3 位数字', 400);
    const id = `${clientId}:${code}`;
    const existing = db.get('lucky_code', id);
    if (existing === undefined) throw new DomainError('该幸运号不存在', 404);
    if (LuckyCodeSchema.parse(existing).clientId !== clientId) throw new DomainError('无权删除他人的幸运号', 403);
    db.delete('lucky_code', id);
  }

  return { list, save, remove };
}

export type LuckyModule = ReturnType<typeof createLuckyModule>;
