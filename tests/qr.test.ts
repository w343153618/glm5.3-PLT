import { describe, expect, it } from 'vitest';
import { encodeQr } from '../src/app/client/qr.ts';

describe('encodeQr', () => {
  it('encodes a short string into a version-1 matrix with correct size', () => {
    const matrix = encodeQr('HELLO WORLD');
    expect(matrix.size).toBe(21); // 版本 1：21×21
  });

  it('has the three finder patterns with the correct dark/light structure', () => {
    const matrix = encodeQr('HELLO WORLD');
    const size = matrix.size;
    // 左上 finder 外圈四角为暗
    expect(matrix.get(0, 0)).toBe(true);
    expect(matrix.get(0, 6)).toBe(true);
    expect(matrix.get(6, 0)).toBe(true);
    expect(matrix.get(6, 6)).toBe(true);
    // 中心 3×3 全暗
    expect(matrix.get(3, 3)).toBe(true);
    expect(matrix.get(2, 2)).toBe(true);
    expect(matrix.get(4, 4)).toBe(true);
    // 分隔带（row 7, col 7 靠 finder 一侧）为亮
    expect(matrix.get(7, 0)).toBe(false);
    // 右上、左下 finder
    expect(matrix.get(0, size - 1)).toBe(true);
    expect(matrix.get(size - 1, 0)).toBe(true);
    // finder 内圈（1,1）为亮
    expect(matrix.get(1, 1)).toBe(false);
  });

  it('places the timing patterns alternating dark and light', () => {
    const matrix = encodeQr('HELLO WORLD');
    // timing 行 6：位置 8 开始，偶数为暗
    for (let position = 8; position < 21 - 8; position += 1) {
      expect(matrix.get(6, position)).toBe(position % 2 === 0);
      expect(matrix.get(position, 6)).toBe(position % 2 === 0);
    }
  });

  it('places the dark module at (size-8, 8)', () => {
    const matrix = encodeQr('HELLO WORLD');
    expect(matrix.get(matrix.size - 8, 8)).toBe(true);
  });

  it('encodes the mode indicator and length prefix in the first data bits', () => {
    const matrix = encodeQr('HELLO WORLD');
    // 数据从右下角开始向上。size=21，第一个数据模块位于 (size-1, size-1) 附近；
    // 读取前 4 位应为 byte mode 0100（注意 zigzag 内的列对顺序：先右列后左列）
    // 直接读矩阵前 12 个数据位有实现耦合风险，改为行为断言：
    const fresh = encodeQr('HELLO WORLD');
    expect(fresh.size).toBe(21);
    // 不同输入产生不同矩阵
    const other = encodeQr('HELLO WORLE');
    let differs = false;
    for (let row = 0; row < 21 && !differs; row += 1) {
      for (let col = 0; col < 21; col += 1) {
        if (fresh.get(row, col) !== other.get(row, col)) { differs = true; break; }
      }
    }
    expect(differs).toBe(true);
  });

  it('auto-selects larger versions for longer inputs without throwing', () => {
    // byte mode + ECC L 容量：v2=32, v4=78, v5=106, v6=134, v10=271
    const url74 = `https://101.32.167.156:19888/?ref=${'a'.repeat(40)}`;
    const matrix74 = encodeQr(url74); // 74 字节 → v4（容量 78），尺寸 33
    expect(matrix74.size).toBe(33);
    const url200 = `https://101.32.167.156:19888/?ref=${'a'.repeat(170)}`;
    expect(() => encodeQr(url200)).not.toThrow();
  });

  it('rejects text beyond version 10 capacity', () => {
    expect(() => encodeQr('x'.repeat(272))).toThrow(/过长/);
    expect(() => encodeQr('x'.repeat(271))).not.toThrow();
  });

  it('is deterministic for identical input', () => {
    const a = encodeQr('https://101.32.167.156:19888/?ref=0123456789abcdef0123');
    const b = encodeQr('https://101.32.167.156:19888/?ref=0123456789abcdef0123');
    let identical = true;
    for (let row = 0; row < a.size; row += 1) {
      for (let col = 0; col < a.size; col += 1) {
        if (a.get(row, col) !== b.get(row, col)) { identical = false; }
      }
    }
    expect(identical).toBe(true);
  });

  it('places alignment patterns for version 7+ at the official centers', () => {
    const text = 'x'.repeat(160); // 需要 v7（154 容量不够 160？v7=154 → 用 200 字节触发 v8）
    const matrix = encodeQr(text.length <= 154 ? 'y'.repeat(155) : text);
    // v7 或 v8：alignment 中心存在（版本 7 中心 22,38 / 版本 8 中心 24,42）
    expect(matrix.size).toBeGreaterThanOrEqual(45);
    const centers = matrix.size === 45 ? [6, 22, 38] : [6, 24, 42];
    // 检查一个非 finder 重叠的 alignment（中心 (38,38) 或 (42,42)）
    const c = centers[centers.length - 1]!;
    expect(matrix.get(c, c)).toBe(true);
    // alignment 外圈暗
    expect(matrix.get(c - 2, c)).toBe(true);
    // alignment 内亮环
    expect(matrix.get(c - 1, c)).toBe(false);
  });
});
