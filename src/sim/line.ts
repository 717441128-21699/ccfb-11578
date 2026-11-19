import {
  BLOCK_MIN_LENGTH,
  BLOCK_SPREAD,
  BLOCK_TARGET_LENGTH,
  LINE_END_MARGIN,
  MAX_SPEED,
  STATION_COUNT,
  TRAIN_LENGTH,
} from './constants';
import { Rng } from './rng';
import type {
  BlockDef,
  CurvePoint,
  GradePoint,
  SpeedPoint,
  StationDef,
  TrackId,
} from './types';

export interface GradeSegment {
  start: number;
  end: number;
  grade: number;
}

export interface CurveSegment {
  start: number;
  end: number;
  /** Signed radius; Infinity = tangent. */
  radius: number;
}

export interface SpeedSegment {
  start: number;
  end: number;
  speed: number;
}

export interface GeometryPoint {
  chainage: number;
  x: number;
  y: number;
  z: number;
  /** Heading in radians, measured from +x toward +z. */
  heading: number;
}

export interface Line {
  stations: StationDef[];
  /** Indexed by track id. */
  blocks: BlockDef[][];
  gradeSegments: GradeSegment[];
  curveSegments: CurveSegment[];
  speedSegments: SpeedSegment[];
  geometry: GeometryPoint[];
  length: number;
}

const STATION_NAMES = [
  '临江大道', '滨江公园', '会展中心', '市政府', '体育中心', '文化广场', '大学城北',
  '理工大学', '科技园', '云栖谷', '东湖', '梨园', '火车站', '长途客运站',
  '机场路', '保税区', '工业园', '汽车城', '北苑', '北客站',
];

const GEOMETRY_STEP = 20;

export function generateLine(seed = 20261119): Line {
  const rng = new Rng(seed);

  // ---- Stations: interstation distances 1.5-2.2 km ----------------------
  const stations: StationDef[] = [];
  let chainage = 400;
  for (let i = 0; i < STATION_COUNT; i++) {
    stations.push({
      id: i,
      name: STATION_NAMES[i],
      chainage: Math.round(chainage),
      platformLength: 135,
    });
    if (i < STATION_COUNT - 1) {
      chainage += rng.range(1500, 2200);
    }
  }
  const length = chainage + 400;

  // ---- Grade profile: gentle metro grades, stations on level track -------
  const gradeSegments: GradeSegment[] = [];
  const gradePoints: GradePoint[] = [{ chainage: 0, grade: 0 }];
  let cursor = 0;
  while (cursor < length) {
    const nextStation = stations.find((s) => s.chainage > cursor + 200);
    let segEnd = Math.min(length, cursor + rng.range(350, 800));
    // Keep 250 m either side of every station level.
    if (nextStation && segEnd > nextStation.chainage - 250) {
      segEnd = nextStation.chainage - 250;
    }
    if (segEnd <= cursor) segEnd = Math.min(length, nextStation ? nextStation.chainage + 250 : length);
    const grade = segEnd <= cursor ? 0 : rng.pick([0, 0, 0.008, -0.008, 0.015, -0.015, 0.022, -0.022]);
    gradeSegments.push({ start: cursor, end: segEnd, grade });
    gradePoints.push({ chainage: segEnd, grade });
    cursor = segEnd;
  }
  gradeSegments[gradeSegments.length - 1].end = length;

  // ---- Curves -------------------------------------------------------------
  const curveSegments: CurveSegment[] = [];
  const curvePoints: CurvePoint[] = [{ chainage: 0, radius: Infinity }];
  cursor = 600;
  while (cursor < length - 400) {
    const curveLen = rng.range(220, 480);
    const radius = rng.pick([600, 700, 850, 1000, 1400]) * (rng.next() < 0.5 ? -1 : 1);
    const start = Math.round(cursor);
    const end = Math.min(length - 300, Math.round(cursor + curveLen));
    if (end - start > 100 && !stations.some((s) => s.chainage > start - 160 && s.chainage < end + 160)) {
      curveSegments.push({ start, end, radius });
      curvePoints.push({ chainage: start, radius });
      curvePoints.push({ chainage: end, radius: Infinity });
      cursor = end + rng.range(400, 900);
    } else {
      cursor += 300;
    }
  }

  // ---- Permanent speed restrictions --------------------------------------
  const speedSegments: SpeedSegment[] = [];
  const speedPoints: SpeedPoint[] = [{ chainage: 0, speed: MAX_SPEED }];
  let segStart = 0;
  let segSpeed = MAX_SPEED;
  for (const curve of curveSegments) {
    if (Math.abs(curve.radius) <= 750) {
      const reduced = Math.min(MAX_SPEED, Math.round((45 / 3.6) * 10) / 10);
      speedSegments.push({ start: segStart, end: curve.start - 120, speed: segSpeed });
      speedSegments.push({ start: curve.start - 120, end: curve.end + 120, speed: reduced });
      speedPoints.push({ chainage: curve.start - 120, speed: reduced });
      speedPoints.push({ chainage: curve.end + 120, speed: segSpeed });
      segStart = curve.end + 120;
    }
  }
  speedSegments.push({ start: segStart, end: length, speed: segSpeed });

  // ---- Fixed blocks per track ---------------------------------------------
  const blocks: BlockDef[][] = [];
  for (const trackId of [0, 1] as TrackId[]) {
    const trackBlocks: BlockDef[] = [];
    const boundaries: number[] = [0];
    let b = 0;
    while (b < length) {
      let next = b + BLOCK_TARGET_LENGTH + rng.range(-BLOCK_SPREAD, BLOCK_SPREAD);
      // Snap to a station chainage only when it is within the natural end
      // window and the resulting block stays long enough.
      const snap = stations.find(
        (s) =>
          s.chainage > b + BLOCK_MIN_LENGTH &&
          s.chainage >= next - 60 &&
          s.chainage <= next + 60,
      );
      if (snap && snap.chainage - b >= BLOCK_MIN_LENGTH) next = snap.chainage;
      next = Math.min(next, length);
      boundaries.push(Math.round(next));
      b = next;
    }
    let id = 0;
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      const station = stations.find((s) => s.chainage >= start && s.chainage < end);
      trackBlocks.push({
        id: id++,
        trackId,
        start,
        end,
        stationId: station ? station.id : null,
      });
    }
    blocks.push(trackBlocks);
  }

  // ---- Centre-line geometry -----------------------------------------------
  const geometry = buildGeometry(length, gradePoints, curvePoints);

  return { stations, blocks, gradeSegments, curveSegments, speedSegments, geometry, length };
}

function buildGeometry(
  length: number,
  gradePoints: GradePoint[],
  curvePoints: CurvePoint[],
): GeometryPoint[] {
  const points: GeometryPoint[] = [];
  let x = 0;
  let z = 0;
  let y = 0;
  let heading = 0.35; // start slightly angled so the line isn't axis-aligned
  let prev: GeometryPoint | null = null;

  for (let s = 0; s <= length; s += GEOMETRY_STEP) {
    if (prev) {
      const ds = s - prev.chainage;
      const radius = valueAt(curvePoints, s, Infinity, (p) => p.radius);
      if (Number.isFinite(radius)) {
        heading += ds / radius;
      }
      const grade = valueAt(gradePoints, s, 0, (p) => p.grade);
      const horiz = ds * Math.cos(Math.atan(grade));
      x += Math.cos(heading) * horiz;
      z += Math.sin(heading) * horiz;
      y += grade * horiz;
    }
    const p: GeometryPoint = {
      chainage: Math.min(s, length),
      x,
      y,
      z,
      heading,
    };
    points.push(p);
    prev = p;
  }
  return points;
}

function valueAt<T extends { chainage: number }>(
  points: T[],
  chainage: number,
  fallback: number,
  pick: (p: T) => number,
): number {
  let value = fallback;
  for (const p of points) {
    if (p.chainage <= chainage) value = pick(p);
    else break;
  }
  return value;
}

// ---- Query helpers --------------------------------------------------------

export function blockAt(line: Line, trackId: TrackId, chainage: number): BlockDef | null {
  const list = line.blocks[trackId];
  if (chainage < 0 || chainage > line.length) return null;
  // Binary search on block starts.
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].start <= chainage) lo = mid;
    else hi = mid - 1;
  }
  const block = list[lo];
  return chainage < block.end ? block : null;
}

export function gradeAt(line: Line, chainage: number): number {
  for (const seg of line.gradeSegments) {
    if (chainage >= seg.start && chainage < seg.end) return seg.grade;
  }
  return line.gradeSegments[line.gradeSegments.length - 1]?.grade ?? 0;
}

export function curveAt(line: Line, chainage: number): number {
  for (const seg of line.curveSegments) {
    if (chainage >= seg.start && chainage < seg.end) return seg.radius;
  }
  return Infinity;
}

export function speedLimitAt(line: Line, chainage: number): number {
  for (const seg of line.speedSegments) {
    if (chainage >= seg.start && chainage < seg.end) return seg.speed;
  }
  return line.speedSegments[line.speedSegments.length - 1]?.speed ?? MAX_SPEED;
}

/** Minimum line speed over [from, to), used for brake-curve target speed. */
export function minSpeedAhead(line: Line, from: number, to: number): number {
  let min = speedLimitAt(line, from);
  for (const seg of line.speedSegments) {
    if (seg.end <= from || seg.start >= to) continue;
    min = Math.min(min, seg.speed);
  }
  return min;
}

export function geometryAt(line: Line, chainage: number): GeometryPoint {
  const geo = line.geometry;
  const clamped = Math.max(0, Math.min(line.length, chainage));
  let lo = 0;
  let hi = geo.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (geo[mid].chainage <= clamped) lo = mid;
    else hi = mid - 1;
  }
  const a = geo[lo];
  const b = geo[Math.min(lo + 1, geo.length - 1)];
  const t = b.chainage === a.chainage ? 0 : (clamped - a.chainage) / (b.chainage - a.chainage);
  return {
    chainage: clamped,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    heading: a.heading + wrapAngle(b.heading - a.heading) * t,
  };
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export { LINE_END_MARGIN, TRAIN_LENGTH };
