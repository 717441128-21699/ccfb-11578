import type { Line } from '../sim/line';
import { geometryAt } from '../sim/line';
import { TRAIN_LENGTH, CAR_LENGTH } from '../sim/constants';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

interface Builder {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

function newBuilder(): Builder {
  return { positions: [], normals: [], colors: [], indices: [] };
}

function addBox(
  b: Builder,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  color: [number, number, number],
  heading = 0,
): void {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const local: [number, number, number][] = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const base = b.positions.length / 3;
  for (const p of local) {
    const rx = p[0] * cos + p[2] * sin;
    const rz = -p[0] * sin + p[2] * cos;
    b.positions.push(cx + rx, cy + p[1], cz + rz);
    b.colors.push(...color);
  }
  const faces: [number, number, number, number, number, number][] = [
    [0, 1, 2, 0, 2, 3], // -z
    [4, 6, 5, 4, 7, 6], // +z
    [0, 4, 5, 0, 5, 1], // -y
    [3, 2, 6, 3, 6, 7], // +y
    [0, 3, 7, 0, 7, 4], // -x
    [1, 5, 6, 1, 6, 2], // +x
  ];
  const faceNormals: [number, number, number][] = [
    [0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0],
  ];
  faces.forEach((f, fi) => {
    const n = faceNormals[fi];
    for (let k = 0; k < 6; k++) b.normals.push(...n);
    b.indices.push(base + f[0], base + f[1], base + f[2], base + f[3], base + f[4], base + f[5]);
  });
}

function addRail(b: Builder, line: Line, lateral: number, color: [number, number, number]): void {
  const geo = line.geometry;
  const halfWidth = 0.08;
  for (let i = 0; i < geo.length - 1; i++) {
    const a = geo[i];
    const c = geo[i + 1];
    const aL = lateralOffset(a, lateral - halfWidth);
    const aR = lateralOffset(a, lateral + halfWidth);
    const cL = lateralOffset(c, lateral - halfWidth);
    const cR = lateralOffset(c, lateral + halfWidth);
    const base = b.positions.length / 3;
    b.positions.push(
      aL[0], a.y + 0.15, aL[1],
      aR[0], a.y + 0.15, aR[1],
      cR[0], c.y + 0.15, cR[1],
      cL[0], c.y + 0.15, cL[1],
    );
    for (let k = 0; k < 4; k++) b.normals.push(0, 1, 0);
    for (let k = 0; k < 4; k++) b.colors.push(...color);
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function lateralOffset(p: { x: number; y: number; z: number; heading: number }, lateral: number): [number, number] {
  // Perpendicular horizontal offset.
  const px = -Math.sin(p.heading);
  const pz = Math.cos(p.heading);
  return [p.x + px * lateral, p.z + pz * lateral];
}

export function buildTrackMesh(line: Line): MeshData {
  const b = newBuilder();
  // Two rails per track, offset laterally for the two running tracks.
  for (const trackOffset of [-2.2, 2.2]) {
    addRail(b, line, trackOffset - 0.7, [0.35, 0.36, 0.4]);
    addRail(b, line, trackOffset + 0.7, [0.35, 0.36, 0.4]);
  }
  return toMesh(b);
}

export function buildGroundMesh(line: Line): MeshData {
  const b = newBuilder();
  // A wide ribbon following the line centre, laid just below the rails.
  const geo = line.geometry;
  const width = 40;
  for (let i = 0; i < geo.length - 1; i++) {
    const a = geo[i];
    const c = geo[i + 1];
    const aL = lateralOffset(a, -width);
    const aR = lateralOffset(a, width);
    const cL = lateralOffset(c, -width);
    const cR = lateralOffset(c, width);
    const base = b.positions.length / 3;
    b.positions.push(
      aL[0], a.y - 0.4, aL[1],
      aR[0], a.y - 0.4, aR[1],
      cR[0], c.y - 0.4, cR[1],
      cL[0], c.y - 0.4, cL[1],
    );
    for (let k = 0; k < 4; k++) b.normals.push(0, 1, 0);
    const shade = 0.16 + (i % 2) * 0.015;
    for (let k = 0; k < 4; k++) b.colors.push(shade, shade * 1.15, shade * 0.9);
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return toMesh(b);
}

export function buildStationMesh(line: Line): MeshData {
  const b = newBuilder();
  for (const s of line.stations) {
    const g = geometryAt(line, s.chainage);
    // Platform slab beside each track.
    for (const side of [-1, 1]) {
      const off = lateralOffset(g, side * 4.5);
      addBox(
        b,
        off[0],
        g.y + 0.4,
        off[1],
        s.platformLength,
        0.8,
        3.2,
        [0.55, 0.55, 0.58],
        g.heading,
      );
    }
    // Stopping marker post on the centre line.
    addBox(b, g.x, g.y + 0.6, g.z, 0.25, 1.2, 0.25, [0.9, 0.85, 0.3]);
  }
  return toMesh(b);
}

export function buildSignalMesh(line: Line): MeshData {
  const b = newBuilder();
  for (const trackId of [0, 1] as const) {
    for (const block of line.blocks[trackId]) {
      const g = geometryAt(line, block.start);
      const off = lateralOffset(g, trackId === 0 ? -3.4 : 3.4);
      addBox(b, off[0], g.y + 1.4, off[1], 0.18, 2.8, 0.18, [0.2, 0.2, 0.22]);
      addBox(b, off[0], g.y + 2.7, off[1], 0.5, 0.5, 0.5, [0.12, 0.12, 0.12]);
    }
  }
  return toMesh(b);
}

export interface LampInstance {
  x: number;
  y: number;
  z: number;
  color: [number, number, number];
}

/** Signal lamp positions (the renderer recolours these each frame). */
export function buildSignalLamps(line: Line): LampInstance[] {
  const lamps: LampInstance[] = [];
  for (const trackId of [0, 1] as const) {
    for (const block of line.blocks[trackId]) {
      const g = geometryAt(line, block.start);
      const off = lateralOffset(g, trackId === 0 ? -3.4 : 3.4);
      lamps.push({ x: off[0], y: g.y + 2.7, z: off[1], color: [0.2, 0.2, 0.2] });
    }
  }
  return lamps;
}

/** One boxy six-car train; returned in local space centred on the train front. */
export function buildTrainMesh(color: [number, number, number]): MeshData {
  const b = newBuilder();
  const cars = Math.round(TRAIN_LENGTH / CAR_LENGTH);
  for (let i = 0; i < cars; i++) {
    // Cars extend backward from the front.
    const cx = -(i + 0.5) * CAR_LENGTH;
    addBox(b, cx, 1.5, 0, CAR_LENGTH - 0.4, 2.8, 2.6, color);
    // Roof equipment.
    addBox(b, cx, 3.1, 0, CAR_LENGTH - 2, 0.4, 1.6, [0.18, 0.18, 0.2]);
  }
  return toMesh(b);
}

/** Unit cube centred on the origin, used for instanced signal lamps. */
export function buildUnitCubeMesh(): MeshData {
  const b = newBuilder();
  addBox(b, 0, 0, 0, 1, 1, 1, [1, 1, 1]);
  return toMesh(b);
}

function toMesh(b: Builder): MeshData {
  return {
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    colors: new Float32Array(b.colors),
    indices: new Uint32Array(b.indices),
  };
}
