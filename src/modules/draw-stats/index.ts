/**
 * draw-stats — 开奖数据统计服务（纯计算，无 IO）。
 * 数据来源：strategy 模块的 resolution 表（已同步的官方开奖）。
 * 口径：
 *   - 频率/分布按窗口（最近 N 期）计算；
 *   - 遗漏从全量开奖序列计算（距最近一次出现隔了多少期，最新一期出现 = 0，从未出现 = 全量期数）；
 *   - 和值 = 三位数之和（0-27）；跨度 = 最大位 − 最小位（0-9）；
 *   - 组选命中 = 任意排列相同（排序后比较）。
 * 文案红线：只用「走势参考」「历史统计」，不做任何推荐号码逻辑。
 */
import { z } from 'zod';
import { DomainError } from '../../shared/errors.ts';
import type { ResolutionEvent } from '../../shared/schemas/domain.ts';
import type { StrategyModule } from '../strategy/index.ts';

const TrendsWindowSchema = z.union([z.literal(30), z.literal(50), z.literal(100)]);
const RecentDaysSchema = z.coerce.number().int().min(1).max(30);

export interface DrawRecord { date: string; code: string }
export interface PositionTally { counts: number[] } // 0-9 出现次数
export interface PositionOmission { periods: number[] } // 0-9 当前遗漏期数

export interface Trends {
  total: number; // 实际参与期数（窗口不足时 < window）
  window: number;
  draws: DrawRecord[]; // date 降序
  positions: PositionTally[];
  omission: PositionOmission[];
  sum: number[]; // 和值 0-27 计数
  span: number[]; // 跨度 0-9 计数
}

export interface CodeHistory {
  code: string;
  straightHits: number;
  groupHits: number;
  lastStraightHit: string | null;
  lastGroupHit: string | null;
}

export interface RecentDraws { days: number; draws: DrawRecord[] }

export function createDrawStatsModule(strategy: Pick<StrategyModule, 'listResolutions'>) {
  /** 全量开奖，date 降序（最新在前）。 */
  function allDraws(): DrawRecord[] {
    return strategy.listResolutions()
      .map((event: ResolutionEvent) => ({ date: event.date, code: event.settlementCode }))
      .sort((left, right) => right.date.localeCompare(left.date));
  }

  function trends(rawWindow: unknown): Trends {
    const window = TrendsWindowSchema.catch(30).parse(rawWindow);
    const draws = allDraws();
    if (draws.length === 0) throw new DomainError('暂无已同步的开奖数据', 404);
    const slice = draws.slice(0, window);

    // 频率：窗口内每个位置 0-9 出现次数
    const positions: PositionTally[] = [0, 1, 2].map(() => ({ counts: Array<number>(10).fill(0) }));
    for (const draw of slice) {
      for (const pos of [0, 1, 2]) positions[pos]!.counts[Number(draw.code[pos])]! += 1;
    }

    // 遗漏：全量序列，从最新往回，某数字在该位置最近一次出现的期距；从未出现 = 全量期数
    const omission: PositionOmission[] = [0, 1, 2].map(() => ({ periods: Array<number>(10).fill(draws.length) }));
    for (let pos = 0; pos < 3; pos += 1) {
      for (let index = 0; index < draws.length; index += 1) {
        const digit = Number(draws[index]!.code[pos]);
        if (omission[pos]!.periods[digit] === draws.length) omission[pos]!.periods[digit] = index;
      }
    }

    // 和值 / 跨度分布：窗口内
    const sum = Array<number>(28).fill(0);
    const span = Array<number>(10).fill(0);
    for (const draw of slice) {
      const digits = [0, 1, 2].map(pos => Number(draw.code[pos]));
      sum[digits.reduce((left, right) => left + right, 0)]! += 1;
      span[Math.max(...digits) - Math.min(...digits)]! += 1;
    }

    return { total: slice.length, window, draws: slice, positions, omission, sum, span };
  }

  function codeHistory(rawCode: unknown): CodeHistory {
    const code = String(rawCode ?? '');
    if (!/^[0-9]{3}$/.test(code)) throw new DomainError('号码须为 3 位数字', 400);
    const draws = allDraws();
    const sorted = (value: string) => value.split('').sort().join('');
    let straightHits = 0;
    let groupHits = 0;
    let lastStraightHit: string | null = null;
    let lastGroupHit: string | null = null;
    for (const draw of draws) { // date 降序：首次命中即最近一次
      if (draw.code === code) { straightHits += 1; if (!lastStraightHit) lastStraightHit = draw.date; }
      if (sorted(draw.code) === sorted(code)) { groupHits += 1; if (!lastGroupHit) lastGroupHit = draw.date; }
    }
    return { code, straightHits, groupHits, lastStraightHit, lastGroupHit };
  }

  function recent(rawDays: unknown): RecentDraws {
    const days = RecentDaysSchema.parse(rawDays);
    const draws = allDraws();
    if (draws.length === 0) throw new DomainError('暂无已同步的开奖数据', 404);
    // 以最新一期日期为锚点往前推 N 天（日历天），窗口内开出的号码集合
    const anchor = new Date(`${draws[0]!.date}T00:00:00Z`);
    anchor.setUTCDate(anchor.getUTCDate() - (days - 1));
    const limit = anchor.toISOString().slice(0, 10);
    return { days, draws: draws.filter(draw => draw.date >= limit) };
  }

  return { trends, codeHistory, recent };
}

export type DrawStatsModule = ReturnType<typeof createDrawStatsModule>;
