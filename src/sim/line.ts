import { CONFIG } from './config';
import { forwardDistance } from './mathutil';

export interface Station {
  index: number;
  name: string;
  /** 停车标里程 */
  stopS: number;
  /** 站台起点/终点里程（环线绝对坐标） */
  platformStart: number;
  platformEnd: number;
}

export interface Block {
  id: number;
  startS: number;
  endS: number;
  length: number;
  /** 是否为站台/停车区域（停车标所在分区及其前后分区） */
  platform: boolean;
  stationIndex: number | null;
}

export interface GradientSegment {
  startS: number;
  endS: number;
  /** 坡度千分率 ‰，上坡为正 */
  grade: number;
}

export interface CurveSegment {
  startS: number;
  endS: number;
  radius: number; // m，正值；直线为 null
}

export interface SpeedLimitSegment {
  startS: number;
  endS: number;
  maxSpeed: number; // m/s
}

export interface Line {
  length: number;
  stations: Station[];
  blocks: Block[];
  gradients: GradientSegment[];
  curves: CurveSegment[];
  speedLimits: SpeedLimitSegment[];
}

/** 确定性伪随机，保证每次加载同一条线路 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATION_NAMES = [
  '车辆段', '北苑', '清河营', '望京西', '太阳宫', '东直门', '朝阳门', '建国门',
  '北京站', '崇文门', '前门', '复兴门', '阜成门', '西直门', '积水潭', '鼓楼',
  '安定门', '雍和宫', '柳芳', '光熙门',
];

export function buildLine(seed = 20261118): Line {
  const rnd = mulberry32(seed);
  const stationCount = CONFIG.line.stationCount;

  // ---- 站间距 1800~2400m，环线 ----
  const stopPositions: number[] = [];
  let s = 0;
  for (let i = 0; i < stationCount; i++) {
    stopPositions.push(s);
    s += 1800 + rnd() * 600;
  }
  const length = s; // 闭合回起点

  const stations: Station[] = stopPositions.map((stopS, i) => ({
    index: i,
    name: STATION_NAMES[i % STATION_NAMES.length],
    stopS,
    platformStart: stopS - CONFIG.station.platformLength / 2,
    platformEnd: stopS + CONFIG.station.platformLength / 2,
  }));

  // ---- 闭塞分区：站间按 ~300m 切，站台附近缩短到 ~120m ----
  const blocks: Block[] = [];
  let blockId = 0;
  let cursor = 0;
  for (let i = 0; i < stationCount; i++) {
    const from = stopPositions[i];
    const to = i + 1 < stationCount ? stopPositions[i + 1] : length;
    const platformEnd = from + 220; // 出站前两个短分区
    const cuts: number[] = [from];

    cursor = from;
    while (cursor < to) {
      const nearPlatform = cursor < platformEnd;
      // 短分区也必须显著大于车长（118m），否则一列车跨多个分区会破坏授权语义
      const step = nearPlatform ? 150 : CONFIG.line.blockNominalLength;
      cursor = Math.min(to, cursor + step + (rnd() - 0.5) * 30);
      if (to - cursor < 80) cursor = to;
      cuts.push(cursor);
    }

    for (let k = 0; k < cuts.length - 1; k++) {
      const startS = cuts[k];
      const endS = cuts[k + 1];
      const mid = (startS + endS) / 2;
      const st = stations.find(
        (stn) => mid >= stn.platformStart && mid <= stn.platformEnd,
      );
      blocks.push({
        id: blockId++,
        startS,
        endS: endS === length ? length : endS,
        length: endS - startS,
        platform: !!st,
        stationIndex: st ? st.index : null,
      });
    }
  }

  // ---- 坡度分区：每 600~1200m 一段，-25‰..+25‰，站台范围内尽量平直 ----
  const gradients: GradientSegment[] = [];
  cursor = 0;
  while (cursor < length) {
    const segLen = 600 + rnd() * 600;
    const endS = Math.min(length, cursor + segLen);
    const mid = (cursor + endS) / 2;
    const onPlatform = stations.some(
      (stn) => mid > stn.platformStart - 100 && mid < stn.platformEnd + 100,
    );
    const grade = onPlatform ? (rnd() - 0.5) * 2 : Math.round((rnd() * 50 - 25) / 5) * 5;
    gradients.push({ startS: cursor, endS, grade });
    cursor = endS;
  }

  // ---- 曲线：随机布置，半径 350~2000m ----
  const curves: CurveSegment[] = [];
  cursor = 400;
  while (cursor < length - 400) {
    const segLen = 300 + rnd() * 700;
    const endS = Math.min(length - 50, cursor + segLen);
    const mid = (cursor + endS) / 2;
    const onPlatform = stations.some(
      (stn) => mid > stn.platformStart - 150 && mid < stn.platformEnd + 150,
    );
    if (!onPlatform && rnd() > 0.35) {
      const radius = Math.round(350 + rnd() * 1650);
      curves.push({ startS: cursor, endS, radius });
    }
    cursor = endS + 200 + rnd() * 500;
  }

  // ---- 静态限速：全线 80，曲线按半径限速 ----
  const speedLimits: SpeedLimitSegment[] = [{ startS: 0, endS: length, maxSpeed: CONFIG.train.maxSpeed }];
  for (const c of curves) {
    // 简化的曲线允许速度 v = sqrt(r * 允许未平衡横向加速度)
    const curveLimit = Math.sqrt(c.radius * 0.55);
    if (curveLimit < CONFIG.train.maxSpeed) {
      speedLimits.push({ startS: c.startS, endS: c.endS, maxSpeed: Math.min(curveLimit, CONFIG.train.maxSpeed) });
    }
  }

  return { length, stations, blocks, gradients, curves, speedLimits };
}

// ---------- 查询工具 ----------

export function blockIndexAt(line: Line, s: number): number {
  const x = ((s % line.length) + line.length) % line.length;
  // 二分查找
  let lo = 0;
  let hi = line.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (line.blocks[mid].endS <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function blockAt(line: Line, s: number): Block {
  return line.blocks[blockIndexAt(line, s)];
}

export function gradeAt(line: Line, s: number): number {
  const x = ((s % line.length) + line.length) % line.length;
  for (const g of line.gradients) {
    if (x >= g.startS && x < g.endS) return g.grade;
  }
  return line.gradients[line.gradients.length - 1].grade;
}

export function curveAt(line: Line, s: number): number | null {
  const x = ((s % line.length) + line.length) % line.length;
  for (const c of line.curves) {
    if (x >= c.startS && x < c.endS) return c.radius;
  }
  return null;
}

export function speedLimitAt(line: Line, s: number): number {
  const x = ((s % line.length) + line.length) % line.length;
  let v = Infinity;
  for (const seg of line.speedLimits) {
    if (x >= seg.startS && x < seg.endS) v = Math.min(v, seg.maxSpeed);
  }
  return v;
}

/** 前方最近的限速下降点（用于制动曲线逐段生成），返回 { 距离, 限速 } */
export function nextSpeedReduction(line: Line, s: number, currentLimit: number): { distance: number; speed: number } | null {
  let best: { distance: number; speed: number } | null = null;
  for (const seg of line.speedLimits) {
    if (seg.maxSpeed >= currentLimit) continue;
    const d = forwardDistance(s, seg.startS, line.length);
    if (d < 0.5) continue;
    if (!best || d < best.distance) best = { distance: d, speed: seg.maxSpeed };
  }
  return best;
}

export function nextStation(line: Line, s: number): { station: Station; distance: number } {
  let best: Station | null = null;
  let bestD = Infinity;
  for (const stn of line.stations) {
    const d = forwardDistance(s, stn.stopS, line.length);
    if (d < bestD) {
      bestD = d;
      best = stn;
    }
  }
  return { station: best!, distance: bestD };
}
