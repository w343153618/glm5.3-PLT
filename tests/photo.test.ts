import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPhotoModule, detectImageMime, PHOTO_MAX_BYTES } from '../src/modules/photo/index.ts';
import { DomainError } from '../src/shared/errors.ts';
// 最小合法 PNG（1×1 透明像素）
const MINIMAL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005050203ac9b0fd80000000049454e44ae426082',
  'hex',
);
// 最小合法 JPEG（SOI + APP0 + EOI）
const MINIMAL_JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

let workDir: string;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'plt-photo-')); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

describe('detectImageMime', () => {
  it('recognizes minimal PNG and JPEG magic bytes', () => {
    expect(detectImageMime(MINIMAL_PNG)).toBe('image/png');
    expect(detectImageMime(MINIMAL_JPEG)).toBe('image/jpeg');
  });

  it.each([
    ['text file', Buffer.from('hello world, definitely not an image')],
    ['PNG with corrupted IHDR length', Buffer.concat([MINIMAL_PNG.subarray(0, 4), Buffer.from('000000ff'), MINIMAL_PNG.subarray(8)])],
    ['gif', Buffer.from('GIF89a'.split('').map(c => c.charCodeAt(0)))],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_name, buffer) => {
    expect(detectImageMime(buffer)).toBeNull();
  });
});

describe('photo module save/read', () => {
  it('saves a PNG, returns a rotating token, and reads it back with the correct mime', async () => {
    const photo = createPhotoModule(workDir);
    const orderId = randomUUID();
    const stored = photo.save(orderId, { photoBase64: MINIMAL_PNG.toString('base64') });
    expect(stored.mime).toBe('image/png');
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(workDir, 'photos'))).toEqual([`${orderId}.png`]);
    const result = photo.read(orderId, stored.token, stored);
    expect(result.mime).toBe('image/png');
    // 等流读完关闭，避免 afterEach 清理目录与异步 open 竞争
    await new Promise<void>((resolve) => { result.stream.on('close', resolve); result.stream.resume(); });
  });

  it('re-save overwrites and rotates the token, invalidating the old one', () => {
    const photo = createPhotoModule(workDir);
    const orderId = randomUUID();
    const first = photo.save(orderId, { photoBase64: MINIMAL_PNG.toString('base64') });
    const second = photo.save(orderId, { photoBase64: MINIMAL_JPEG.toString('base64') });
    expect(second.token).not.toBe(first.token);
    expect(readdirSync(join(workDir, 'photos'))).toEqual([`${orderId}.jpg`]); // 旧 png 被替换
    // 旧 token 失效（校验在打开文件之前抛出，无流产生）
    expect(() => photo.read(orderId, first.token, second)).toThrow(DomainError);
  });

  it('accepts dataURL-prefixed base64', () => {
    const photo = createPhotoModule(workDir);
    const orderId = randomUUID();
    const stored = photo.save(orderId, { photoBase64: `data:image/png;base64,${MINIMAL_PNG.toString('base64')}` });
    expect(stored.mime).toBe('image/png');
  });

  it.each([
    ['not base64', '这是明文不是base64!!'],
    ['empty', ''],
    ['valid base64 of text', Buffer.from('plain text').toString('base64')],
  ])('rejects %s payload', (_name, payload) => {
    const photo = createPhotoModule(workDir);
    expect(() => photo.save(randomUUID(), { photoBase64: payload })).toThrow(DomainError);
  });

  it('rejects photos beyond the 5MB decoded limit with 413', () => {
    const photo = createPhotoModule(workDir);
    const oversized = Buffer.concat([MINIMAL_PNG.subarray(0, 8), Buffer.alloc(PHOTO_MAX_BYTES + 1)]);
    expect(() => photo.save(randomUUID(), { photoBase64: oversized.toString('base64') })).toThrow(DomainError);
    try {
      photo.save(randomUUID(), { photoBase64: oversized.toString('base64') });
    } catch (error) {
      expect((error as DomainError).statusCode).toBe(413);
    }
  });

  it('rejects path-injected order ids', () => {
    const photo = createPhotoModule(workDir);
    expect(() => photo.save('../../evil', { photoBase64: MINIMAL_PNG.toString('base64') })).toThrow(DomainError);
  });

  it('read rejects wrong tokens, missing tokens, and missing files', () => {
    const photo = createPhotoModule(workDir);
    const orderId = randomUUID();
    const stored = photo.save(orderId, { photoBase64: MINIMAL_PNG.toString('base64') });
    expect(() => photo.read(orderId, '0'.repeat(64), stored)).toThrow(DomainError);
    // 无 token（尚未上传）→ 404
    try {
      photo.read(orderId, stored.token, { mime: 'image/png' });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).statusCode).toBe(404);
    }
    // 记录了 token 但文件缺失（异常状态）→ 404
    try {
      photo.read(randomUUID(), stored.token, stored);
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).statusCode).toBe(404);
    }
  });

  it('drains the stream so cleanup does not race an open file handle', async () => {
    const photo = createPhotoModule(workDir);
    const orderId = randomUUID();
    const stored = photo.save(orderId, { photoBase64: MINIMAL_PNG.toString('base64') });
    const { stream } = photo.read(orderId, stored.token, stored);
    // 等流真正关闭（读完）再结束用例，afterEach 清理目录不会与异步 open 竞争
    await new Promise<void>((resolve) => { stream.on('close', resolve); stream.resume(); });
  });
});

describe('photo API routes', () => {
  async function apiFixture() {
    const { buildApp } = await import('../src/app/app.ts');
    const { authOptions, login } = await import('./helpers/auth.ts');
    const dir = mkdtempSync(join(tmpdir(), 'plt-photo-api-'));
    const app = await buildApp({
      databasePath: join(dir, 'app.db'), today: '2026-10-14', seed: true, autoSync: false, logger: false, ...authOptions,
    });
    return { app, login: (u: 'admin' | 'dianzhang' | 'user') => login(app, u), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async function firstOrderId(app: Awaited<ReturnType<typeof import('../src/app/app.ts').buildApp>>, cookie: string, clientId?: string): Promise<string> {
    const bootstrap = (await app.inject({ url: '/api/bootstrap', headers: { cookie } })).json();
    const manager = bootstrap.managers[0];
    const orders = (await app.inject({ url: `/api/stores/${manager.storeId}/orders`, headers: { cookie } })).json();
    const order = clientId ? orders.find((row: { clientId: string }) => row.clientId === clientId) : orders[0];
    return order.id;
  }

  it('uploads, reads, and serves a photo end to end with role checks', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const client = await login('user');
      const manager = await login('dianzhang');
      // 选取 user 绑定客户本人的订单，保证客户视角有权查看
      const orderId = await firstOrderId(app, manager.cookie, client.actor.clientId);
      const upload = await app.inject({
        method: 'POST', url: `/api/orders/${orderId}/photo`,
        headers: { cookie: manager.cookie },
        payload: { photoBase64: MINIMAL_PNG.toString('base64') },
      });
      expect(upload.statusCode).toBe(201);
      const { photoToken, photoMime } = upload.json();
      expect(photoToken).toMatch(/^[0-9a-f]{64}$/);
      expect(photoMime).toBe('image/png');

      // 店长查看
      const asManager = await app.inject({ url: `/api/orders/${orderId}/photo?token=${photoToken}`, headers: { cookie: manager.cookie } });
      expect(asManager.statusCode).toBe(200);
      expect(asManager.headers['content-type']).toBe('image/png');
      expect(asManager.headers['cache-control']).toContain('private');
      expect(Buffer.from(asManager.rawPayload)).toEqual(MINIMAL_PNG);

      // 归属客户查看（client 已在用例开头登录）
      const asClient = await app.inject({ url: `/api/orders/${orderId}/photo?token=${photoToken}`, headers: { cookie: client.cookie } });
      expect(asClient.statusCode).toBe(200);

      // 总部查看（用户特别要求管理员可见）
      const admin = await login('admin');
      const asHq = await app.inject({ url: `/api/orders/${orderId}/photo?token=${photoToken}`, headers: { cookie: admin.cookie } });
      expect(asHq.statusCode).toBe(200);
      expect(Buffer.from(asHq.rawPayload)).toEqual(MINIMAL_PNG);
    } finally { await app.close(); cleanup(); }
  });

  it('rejects forged tokens, missing photos, and non-image payloads', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const manager = await login('dianzhang');
      const orderId = await firstOrderId(app, manager.cookie);
      // 无照片先查 → 404（token 缺省校验在鉴权后）
      const before = await app.inject({ url: `/api/orders/${orderId}/photo?token=${'a'.repeat(64)}`, headers: { cookie: manager.cookie } });
      expect(before.statusCode).toBe(404);
      // 非图片 base64 → 400
      const badUpload = await app.inject({
        method: 'POST', url: `/api/orders/${orderId}/photo`,
        headers: { cookie: manager.cookie },
        payload: { photoBase64: Buffer.from('plain text file').toString('base64') },
      });
      expect(badUpload.statusCode).toBe(400);
      // 上传成功后伪造 token → 403
      await app.inject({
        method: 'POST', url: `/api/orders/${orderId}/photo`,
        headers: { cookie: manager.cookie },
        payload: { photoBase64: MINIMAL_JPEG.toString('base64') },
      });
      const forged = await app.inject({ url: `/api/orders/${orderId}/photo?token=${'0'.repeat(64)}`, headers: { cookie: manager.cookie } });
      expect(forged.statusCode).toBe(403);
    } finally { await app.close(); cleanup(); }
  });

  it('blocks clients from uploading and cross-role access', async () => {
    const { app, login, cleanup } = await apiFixture();
    try {
      const client = await login('user');
      const admin = await login('admin');
      const orderId = await firstOrderId(app, admin.cookie);
      // 客户不能上传
      const clientUpload = await app.inject({
        method: 'POST', url: `/api/orders/${orderId}/photo`,
        headers: { cookie: client.cookie },
        payload: { photoBase64: MINIMAL_PNG.toString('base64') },
      });
      expect(clientUpload.statusCode).toBe(403);
      // 未登录一概 401
      const anonymous = await app.inject({ url: `/api/orders/${orderId}/photo?token=x` });
      expect(anonymous.statusCode).toBe(401);
    } finally { await app.close(); cleanup(); }
  });
});
