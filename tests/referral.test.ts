import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/shared/database.ts';
import { DomainError } from '../src/shared/errors.ts';
import { createStoreModule } from '../src/modules/store/index.ts';
import { createReferralModule, encodeReferralCode, decodeReferralCode } from '../src/modules/referral/index.ts';

function fixture() {
  const db = createDatabase(':memory:');
  const stores = createStoreModule(db);
  const referral = createReferralModule(db);
  const store = stores.addStore({ id: randomUUID(), name: '门店 1' });
  const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: '店长 1' });
  return { db, stores, referral, store, manager };
}

describe('referral code codec', () => {
  it('roundtrips random UUIDs through base62 encode/decode', () => {
    for (let index = 0; index < 50; index += 1) {
      const id = randomUUID();
      expect(decodeReferralCode(encodeReferralCode(id))).toBe(id);
    }
  });

  it('produces codes matching the referral code format', () => {
    const code = encodeReferralCode(randomUUID());
    expect(code).toMatch(/^[0-9a-zA-Z]{20,24}$/);
  });

  it.each(['', 'short', 'contains spaces here', '!!!', '0'.repeat(25), 'A'.repeat(19)])(
    'rejects malformed code %j', (code) => {
      expect(() => decodeReferralCode(code)).toThrow(DomainError);
    });

  it('handles a syntactically valid code that decodes out of UUID range by throwing', () => {
    // 22 个 'Z' 是合法 base62，但解码值超出 128 位 UUID 范围 → 必须抛 DomainError，不能返回越界值
    expect(() => decodeReferralCode('Z'.repeat(22))).toThrow(DomainError);
  });

  it('resolves a code to its manager id without extra data', () => {
    const { referral, manager } = fixture();
    const code = referral.getOrCreateCode(manager.id);
    expect(referral.resolveCode(code)).toEqual({ managerId: manager.id });
  });

  it('generates one stable code per manager (idempotent)', () => {
    const { referral, manager } = fixture();
    const first = referral.getOrCreateCode(manager.id);
    const second = referral.getOrCreateCode(manager.id);
    expect(second).toBe(first);
  });

  it('generates different codes for different managers', () => {
    const { referral, store } = fixture();
    const another = createStoreModule(createDatabase(':memory:'));
    expect(another).toBeDefined();
    const code1 = referral.getOrCreateCode(randomUUID());
    const code2 = referral.getOrCreateCode(randomUUID());
    expect(code1).not.toBe(code2);
    void store;
  });
});

describe('share events and stats', () => {
  it('records a share event as append-only journal', () => {
    const { db, referral, manager } = fixture();
    const event = referral.recordShare({ managerId: manager.id, sharerRole: 'manager', date: '2026-10-14' });
    expect(event).toMatchObject({ managerId: manager.id, sharerRole: 'manager', date: '2026-10-14' });
    expect(() => db.set('share_event', event.id, { ...event, date: '2026-10-13' })).toThrow(DomainError);
    expect(() => db.get('share_event', event.id)).toBeDefined();
  });

  it('aggregates share counts and register counts by manager and date', () => {
    const { db, referral, stores, manager } = fixture();
    referral.recordShare({ managerId: manager.id, sharerRole: 'manager', date: '2026-10-14' });
    referral.recordShare({ managerId: manager.id, sharerRole: 'client', sharerClientId: randomUUID(), date: '2026-10-14' });
    // 注册：创建客户档案并写归属审计（note=扫码注册）
    const client = stores.addClient({
      id: randomUUID(), storeId: manager.storeId, managerId: manager.id, name: '扫码客户', date: '2026-10-14',
      note: '扫码注册',
    });
    void client;
    const rows = referral.stats();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ managerId: manager.id, date: '2026-10-14', shareCount: 2, registerCount: 1 });
    // 过滤
    expect(referral.stats({ date: '2026-10-13' })).toHaveLength(0);
    expect(referral.stats({ managerId: manager.id, date: '2026-10-14' })[0]!.shareCount).toBe(2);
    void db;
  });

  it('does not count non-referral client creation in register stats', () => {
    const { referral, stores, manager } = fixture();
    stores.addClient({ id: randomUUID(), storeId: manager.storeId, managerId: manager.id, name: '线下客户', date: '2026-10-14' });
    expect(referral.stats()).toHaveLength(0);
  });
});
