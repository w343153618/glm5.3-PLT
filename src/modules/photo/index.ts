import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, statSync, createReadStream, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DomainError } from '../../shared/errors.ts';
import { PhotoMimeSchema } from '../../shared/schemas/domain.ts';
import type { Readable } from 'node:stream';

/** 解码后单张照片上限：5MB。 */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** 魔数校验：拒绝仅凭 base64 前缀或扩展名伪装的文件。 */
export function detectImageMime(buffer: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('hex') === '89504e47' && buffer.subarray(4, 8).toString('hex') === '0d0a1a0a') return 'image/png';
  return null;
}

export interface StoredPhoto {
  token: string;
  mime: 'image/jpeg' | 'image/png';
}

export function createPhotoModule(baseDir: string) {
  const photoDir = join(baseDir, 'photos');
  if (!existsSync(photoDir)) mkdirSync(photoDir, { recursive: true });

  function extensionOf(mime: 'image/jpeg' | 'image/png'): string {
    return mime === 'image/jpeg' ? 'jpg' : 'png';
  }

  function filePath(orderId: string, mime: 'image/jpeg' | 'image/png'): string {
    // orderId 已由上层 z.uuid() 校验，此处仅防御路径注入
    if (!/^[0-9a-f-]{36}$/.test(orderId)) throw new DomainError('订单标识无效', 400);
    return join(photoDir, `${orderId}.${extensionOf(mime)}`);
  }

  /** 保存照片（覆盖旧文件），返回新 token 与 mime。调用方负责把 token/mime 写入订单记录。 */
  function save(orderId: string, input: { photoBase64: string }): StoredPhoto {
    const base64 = String(input.photoBase64 ?? '').replace(/^data:image\/(jpeg|png);base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length === 0) {
      throw new DomainError('照片数据不是有效的 base64 编码', 400);
    }
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0 || buffer.length % 1 !== 0) throw new DomainError('照片数据损坏', 400);
    const decodedBytes = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (buffer.length !== decodedBytes) throw new DomainError('照片数据损坏', 400);
    if (buffer.length > PHOTO_MAX_BYTES) throw new DomainError(`照片过大：解码后 ${Math.round(buffer.length / 1024 / 1024)}MB，上限 5MB`, 413);
    const mime = detectImageMime(buffer);
    if (!mime) throw new DomainError('仅支持 JPG 或 PNG 格式的照片', 400);
    // 换格式重传时清理另一扩展名的旧文件，保持一单一图
    const otherMime: 'image/jpeg' | 'image/png' = mime === 'image/jpeg' ? 'image/png' : 'image/jpeg';
    const stalePath = filePath(orderId, otherMime);
    if (existsSync(stalePath)) unlinkSync(stalePath);
    writeFileSync(filePath(orderId, mime), buffer);
    return { token: randomBytes(32).toString('hex'), mime };
  }

  /** 读取照片流。token 恒定时间比较，不匹配一律 403。 */
  function read(orderId: string, token: string, expected: { token?: string; mime?: 'image/jpeg' | 'image/png' }):
    { stream: Readable; mime: 'image/jpeg' | 'image/png' } {
    const supplied = Buffer.from(String(token ?? ''), 'utf8');
    const recorded = Buffer.from(expected.token ?? '', 'utf8');
    if (supplied.length !== recorded.length || !timingSafeEqual(supplied, recorded) || !expected.token) {
      throw new DomainError('照片访问令牌不正确', 403);
    }
    const mime = PhotoMimeSchema.parse(expected.mime);
    const path = filePath(orderId, mime);
    if (!existsSync(path)) throw new DomainError('照片不存在或已被替换', 404);
    if (!statSync(path).isFile()) throw new DomainError('照片不存在或已被替换', 404);
    return { stream: createReadStream(path), mime };
  }

  /** 删除照片文件（订单删除场景预留；当前订单不可删除）。 */
  function remove(orderId: string, mime: 'image/jpeg' | 'image/png'): void {
    const path = filePath(orderId, mime);
    if (existsSync(path)) unlinkSync(path);
  }

  return { save, read, remove, photoDir };
}

export type PhotoModule = ReturnType<typeof createPhotoModule>;
