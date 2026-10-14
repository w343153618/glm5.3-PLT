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
  it('saves a PNG, returns a rotating token, and reads it back with the correct mime', () => {
    const photo = createPhotoModule(workDir);
    const orderId = randomUUID();
    const stored = photo.save(orderId, { photoBase64: MINIMAL_PNG.toString('base64') });
    expect(stored.mime).toBe('image/png');
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(join(workDir, 'photos'))).toEqual([`${orderId}.png`]);
    const result = photo.read(orderId, stored.token, stored);
    expect(result.mime).toBe('image/png');
  });

  it('re-save overwrites and rotates the token, invalidating the old one', () => {
    const photo = createPhotoModule(workDir);
    const orderId = randomUUID();
    const first = photo.save(orderId, { photoBase64: MINIMAL_PNG.toString('base64') });
    const second = photo.save(orderId, { photoBase64: MINIMAL_JPEG.toString('base64') });
    expect(second.token).not.toBe(first.token);
    expect(readdirSync(join(workDir, 'photos'))).toEqual([`${orderId}.jpg`]); // 旧 png 被替换
    expect(() => photo.read(orderId, first.token, second)).toThrow(DomainError); // 旧 token 失效
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
    expect(() => photo.read(orderId, stored.token, { mime: 'image/png' })).toThrow(DomainError);
    expect(() => photo.read(randomUUID(), stored.token, stored)).toThrow(DomainError);
  });
});
