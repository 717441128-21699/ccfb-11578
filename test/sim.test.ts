import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/sim/config';
import { clamp, approachFirstOrder, forwardDistance } from '../src/sim/mathutil';
import {
  maxTractionAtSpeed,
  edBrakeAvailability,
  davisResistance,
  gradientResistance,
  curveResistance,
} from '../src/sim/dynamics';
import { permittedSpeedAt, supervisedSpeed, evaluateAtp } from '../src/sim/atp';
import { buildLine, blockAt, gradeAt, speedLimitAt } from '../src/sim/line';

describe('数学工具', () => {
  it('clamp 边界', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('一阶惯性单调趋近且不过冲', () => {
    let y = 0;
    // 5 个时间常数（0.5s）后应达到目标的 99% 以上
    for (let i = 0; i < 600; i++) y = approachFirstOrder(y, 100, 0.5, 1 / 120);
    expect(y).toBeGreaterThan(99);
    expect(y).toBeLessThanOrEqual(100);
  });

  it('环线前向距离', () => {
    expect(forwardDistance(90, 10, 100)).toBe(20);
    expect(forwardDistance(10, 90, 100)).toBe(80);
  });
});

describe('车辆动力学特性', () => {
  const T = CONFIG.train;

  it('牵引力低速恒力、高速随速度下降', () => {
    expect(maxTractionAtSpeed(0)).toBe(T.maxTractionForce);
    expect(maxTractionAtSpeed(10)).toBe(T.maxTractionForce);
    const high = maxTractionAtSpeed(20);
    expect(high).toBeLessThan(T.maxTractionForce);
    // 恒功率段 F*v 近似常数
    expect(high * 20).toBeCloseTo(T.maxTractionForce * T.tractionKneeSpeed, 0);
  });

  it('电制动低速退出', () => {
    expect(edBrakeAvailability(20)).toBe(1);
    expect(edBrakeAvailability(1)).toBe(0);
    const mid = edBrakeAvailability((T.edBrakeKneeSpeed + T.edBrakeFadeSpeed) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('满载与空载 Davis 阻力不同（质量效应）', () => {
    const full = davisResistance(T.massFull, 15);
    const empty = davisResistance(T.massEmpty, 15);
    expect(full).toBeGreaterThan(empty);
    expect(full / empty).toBeCloseTo(T.massFull / T.massEmpty, 3);
  });

  it('坡道阻力方向：上坡阻力为正', () => {
    expect(gradientResistance(100_000, 20)).toBeCloseTo(100_000 * 9.81 * 0.02, 3);
    expect(gradientResistance(100_000, -20)).toBeLessThan(0);
  });

  it('曲线半径越小阻力越大', () => {
    expect(curveResistance(100_000, 400)).toBeGreaterThan(curveResistance(100_000, 1500));
    expect(curveResistance(100_000, null)).toBe(0);
  });
});

describe('ATP 制动曲线', () => {
  it('授权终点处监督速度为 0，距离越远允许速度越高', () => {
    const target = { distance: 300, targetSpeed: 0, kind: 'authority' as const };
    expect(permittedSpeedAt(target, 300)).toBeCloseTo(0, 5);
    const vNear = permittedSpeedAt(target, 290);
    const vFar = permittedSpeedAt(target, 0);
    expect(vFar).toBeGreaterThan(vNear);
    // v^2 = 2 a d
    expect(vFar).toBeCloseTo(Math.sqrt(2 * CONFIG.atp.guaranteedDecel * 300), 5);
  });

  it('多个约束取最严格者', () => {
    const line = buildLine();
    // 选一个离所有车站都足够远的区间位置（避开 450m 停车目标窗口）
    const s = line.stations[0].stopS + 900;
    const train = {
      s,
      v: 0,
      doorsOpen: false,
      authorityEnd: s + 500,
      authorityDistance: 500,
    } as any;
    const auth = { endS: s + 500, distance: 500, endBlockId: 0, blockedBy: null };
    const v = supervisedSpeed(line, train, auth as any);
    expect(v).toBeLessThanOrEqual(speedLimitAt(line, s) + 1e-9);
    expect(v).toBeGreaterThan(0);
  });

  it('超速触发报警与紧急制动两级阈值', () => {
    const line = buildLine();
    const s = line.stations[0].stopS + 900;
    const auth = { endS: s + 200, distance: 200, endBlockId: 0, blockedBy: null };
    const base = supervisedSpeed(
      line,
      { s, v: 0, doorsOpen: false, authorityEnd: s + 200, authorityDistance: 200 } as any,
      auth as any,
    );
    const alarmTrain = {
      s, v: base + CONFIG.atp.ebMargin + 0.5,
      doorsOpen: false, emergencyApplied: false,
      authorityEnd: s + 200, authorityDistance: 200,
    } as any;
    const verdict = evaluateAtp(line, alarmTrain, auth as any);
    expect(verdict.alarm).toBe(true);
    expect(verdict.triggerEB).toBe(true);
  });
});

describe('线路生成', () => {
  const line = buildLine();

  it('20 个站、12 车可均匀布置且分区间无重叠无缺口', () => {
    expect(line.stations).toHaveLength(20);
    let total = 0;
    for (const b of line.blocks) total += b.length;
    expect(total).toBeCloseTo(line.length, 5);
    for (let i = 1; i < line.blocks.length; i++) {
      expect(line.blocks[i].startS).toBeCloseTo(line.blocks[i - 1].endS, 6);
    }
  });

  it('任意里程都能查到分区、坡度与限速', () => {
    for (let s = 0; s < line.length; s += 137) {
      const b = blockAt(line, s);
      expect(s).toBeGreaterThanOrEqual(b.startS - 1e-9);
      expect(s).toBeLessThan(b.endS + 1e-9);
      expect(Number.isFinite(gradeAt(line, s))).toBe(true);
      expect(speedLimitAt(line, s)).toBeGreaterThan(0);
    }
  });
});
