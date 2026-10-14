/**
 * 纯 TypeScript QR Code Model 2 生成器（byte mode, ECC L）。
 * 零依赖：输出模块矩阵（boolean[size][size]），由调用方自行渲染。
 * 支持版本 1-10 自动选择（byte mode, L 纠错：最大 271 字节，覆盖推广 URL）。
 */

// ---- 常量表 ----

/** ECC L 各版本的 (totalCodewords, ecPerBlock, groupBlocks, group1Count, group1Data, group2Blocks, group2Data) */
// 数据来源：ISO/IEC 18004 表 D.1（ECC L，byte mode 容量见附录）
// 简化：版本 1-10 的 L 级全部为单块纠错（1 个纠错块）
const VERSION_TABLE: Array<{ total: number; dataCodewords: number }> = [
  { total: 26, dataCodewords: 19 },   // v1
  { total: 44, dataCodewords: 34 },   // v2
  { total: 70, dataCodewords: 55 },   // v3
  { total: 100, dataCodewords: 80 },  // v4
  { total: 134, dataCodewords: 108 }, // v5
  { total: 172, dataCodewords: 136 }, // v6
  { total: 196, dataCodewords: 156 }, // v7
  { total: 242, dataCodewords: 194 }, // v8
  { total: 292, dataCodewords: 232 }, // v9
  { total: 346, dataCodewords: 274 }, // v10
];

/** 每版本的 byte mode 容量减去 header 后可容纳的最大字节数（ECC L）。 */
const BYTE_CAPACITY_L = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271];

/** 伽罗瓦域 GF(256) 指数与对数表（0x11D 本原多项式）。 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let exponent = 0; exponent < 255; exponent += 1) {
    GF_EXP[exponent] = value;
    GF_LOG[value] = exponent;
    value = (value << 1) ^ (value >= 128 ? 0x11d : 0);
  }
  for (let exponent = 255; exponent < 512; exponent += 1) GF_EXP[exponent] = GF_EXP[exponent - 255] as number;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] as number) + (GF_LOG[b] as number)] as number;
}

/** RS 生成多项式系数（最高次在前）求余，用于生成纠错码字。 */
function rsEncode(data: number[], ecCount: number): number[] {
  let coefficients: number[] = [1];
  for (let root = 0; root < ecCount; root += 1) {
    const next = new Array<number>(coefficients.length + 1).fill(0);
    for (let index = 0; index < coefficients.length; index += 1) {
      next[index]! ^= coefficients[index]!;
      next[index + 1]! ^= gfMul(coefficients[index]!, GF_EXP[root] as number);
    }
    coefficients = next;
  }
  // 生成多项式首项恒为 1，去掉以对齐
  coefficients.shift();
  const remainder = [...data, ...new Array<number>(ecCount).fill(0)];
  for (let position = 0; position <= data.length - 1; position += 1) {
    const factor = remainder[position]!;
    if (factor === 0) continue;
    for (let index = 0; index < coefficients.length; index += 1) {
      remainder[position + index]! ^= gfMul(coefficients[index]!, factor);
    }
  }
  return remainder.slice(data.length);
}

/** alignment 图案中心坐标（版本 1 无；其余按 ISO 表 E.1 收敛规则）。 */
function alignmentCenters(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const last = size - 7;
  const centers: number[] = [6];
  const interval = Math.floor((version - 1) / 4) + 1; // 简化等距，见下
  // 标准：候选等距点，选与 last % interval == 0 的偶数
  const step = Math.floor((last - 6) / Math.max(interval, 1));
  for (let position = last; position > 6; position -= step) {
    centers.unshift(position);
    if (centers.length > 1 && step === 0) break;
  }
  // 修正：用官方等差规则
  const official: Record<number, number[]> = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  void size; void centers; void interval;
  return official[version] ?? [6];
}

// ---- 编码主流程 ----

export interface QrMatrix {
  size: number;
  modules: boolean[][];
  /** true = 该位需要涂黑（dark） */
  get(row: number, col: number): boolean;
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  // 选择版本
  let version = 0;
  for (let candidate = 1; candidate <= 10; candidate += 1) {
    if (bytes.length <= BYTE_CAPACITY_L[candidate - 1]!) { version = candidate; break; }
  }
  if (version === 0) throw new Error('文本过长：QR 版本 1-10（ECC L）最多容纳 271 字节');

  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const set = (row: number, col: number, dark: boolean) => { modules[row]![col] = dark; reserved[row]![col] = true; };

  // 1. finder + separator
  const placeFinder = (top: number, left: number) => {
    for (let row = -1; row <= 7; row += 1) {
      for (let col = -1; col <= 7; col += 1) {
        const r = top + row, c = left + col;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inRing = row >= 0 && row <= 6 && col >= 0 && col <= 6;
        const dark = inRing && (row === 0 || row === 6 || col === 0 || col === 6 || (row >= 2 && row <= 4 && col >= 2 && col <= 4));
        set(r, c, dark);
      }
    }
  };
  placeFinder(0, 0); placeFinder(0, size - 7); placeFinder(size - 7, 0);

  // 2. alignment
  for (const centerRow of alignmentCenters(version)) {
    for (const centerCol of alignmentCenters(version)) {
      // 跳过与 finder 重叠的三个角
      const overlapsFinder = (centerRow <= 8 && centerCol <= 8) || (centerRow <= 8 && centerCol >= size - 9) || (centerRow >= size - 9 && centerCol <= 8);
      if (overlapsFinder) continue;
      for (let row = -2; row <= 2; row += 1) {
        for (let col = -2; col <= 2; col += 1) {
          const dark = Math.max(Math.abs(row), Math.abs(col)) !== 1;
          set(centerRow + row, centerCol + col, dark);
        }
      }
    }
  }

  // 3. timing
  for (let position = 8; position < size - 8; position += 1) {
    const dark = position % 2 === 0;
    set(6, position, dark); set(position, 6, dark);
  }

  // 4. format info 占位（dark module 在 (size-8, 8)）
  set(size - 8, 8, true); // dark module

  // 5. 数据编码：mode 0100 (byte) + 长度 + 数据 + terminator + pad
  const dataBits: number[] = [];
  const pushBits = (value: number, count: number) => {
    for (let index = count - 1; index >= 0; index -= 1) dataBits.push((value >>> index) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) pushBits(byte, 8);

  const { dataCodewords, total } = VERSION_TABLE[version - 1]!;
  const totalBits = total * 8;
  // terminator
  for (let index = 0; index < Math.min(4, totalBits - dataBits.length); index += 1) dataBits.push(0);
  // byte 对齐
  while (dataBits.length % 8 !== 0) dataBits.push(0);
  // 转码字
  const dataCodewordList: number[] = [];
  for (let index = 0; index < dataBits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | (dataBits[index + bit] ?? 0);
    dataCodewordList.push(value);
  }
  // pad
  const pads = [0xec, 0x11];
  for (let index = 0; dataCodewordList.length < dataCodewords; index += 1) {
    dataCodewordList.push(pads[index % 2]!);
  }

  // RS 纠错（L 级 v1-10 单块）
  const ecCount = total - dataCodewords;
  const ecCodewords = rsEncode(dataCodewordList, ecCount);
  const interleaved = [...dataCodewordList, ...ecCodewords];

  // 6. 数据位布置（两列一列向上/向下交替，跳过 reserved 与 v7+ 的 timing 上方列 6）
  let bitIndex = 0;
  const totalDataBits = interleaved.length * 8;
  const bitAt = (index: number): boolean => {
    if (index >= totalDataBits) return false;
    const codeword = interleaved[index >> 3]!;
    return ((codeword >>> (7 - (index & 7))) & 1) === 1;
  };
  let upward = true;
  for (let colPair = size - 1; colPair > 0; colPair -= 2) {
    let col = colPair;
    if (col <= 6) col -= 1; // 跳过 timing 列
    const rows = upward ? [...Array(size).keys()].reverse() : [...Array(size).keys()];
    for (const row of rows) {
      for (const offset of [0, 1]) {
        const c = col - offset;
        if (reserved[row]![c]) continue;
        modules[row]![c] = bitAt(bitIndex);
        bitIndex += 1;
      }
    }
    upward = !upward;
  }

  // 7. format info：ECC L = 01，mask 000（用 BCH 计算）
  const formatBits = computeFormatBits(0b01, 0b000);
  placeFormat(formatBits, modules, size, set);

  const frozen = modules.map(row => [...row]);
  return { size, modules: frozen, get: (row, col) => frozen[row]![col]! };
}

function computeFormatBits(ecBits: number, maskBits: number): boolean[] {
  const data = (ecBits << 3) | maskBits;
  let value = data << 10;
  const generator = 0b10100110111;
  for (let index = 14; index >= 10; index -= 1) {
    if ((value >>> index) & 1) value ^= generator << (index - 10);
  }
  const code = ((data << 10) | (value & 0x3ff)) ^ 0b101010000010010;
  const bits: boolean[] = [];
  for (let index = 14; index >= 0; index -= 1) bits.push(((code >>> index) & 1) === 1);
  return bits;
}

function placeFormat(bits: boolean[], modules: boolean[][], size: number, set: (r: number, c: number, d: boolean) => void) {
  void modules;
  // 围绕左上 finder
  const positionsA: Array<[number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  // 右上与左下
  const positionsB: Array<[number, number]> = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  for (let index = 0; index < 15; index += 1) {
    const [r1, c1] = positionsA[index]!;
    const [r2, c2] = positionsB[index]!;
    set(r1, c1, bits[index]!);
    set(r2, c2, bits[index]!);
  }
}

/** 渲染到 canvas（模块 + 4 倍 quiet zone）。 */
export function drawQrToCanvas(canvas: HTMLCanvasElement, matrix: QrMatrix, modulePixels = 4, quietZone = 4): void {
  const dimension = (matrix.size + quietZone * 2) * modulePixels;
  canvas.width = dimension;
  canvas.height = dimension;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, dimension, dimension);
  context.fillStyle = '#19332f';
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.get(row, col)) {
        context.fillRect((col + quietZone) * modulePixels, (row + quietZone) * modulePixels, modulePixels, modulePixels);
      }
    }
  }
}
