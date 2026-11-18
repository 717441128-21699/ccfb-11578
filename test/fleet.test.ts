import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { CONFIG } from '../src/sim/config';
import { AiDriver } from '../src/sim/driver';
import { supervisedSpeed } from '../src/sim/atp';

/**
 * 车队级浸泡测试：所有 12 列车（含玩家车）都由 AI 驾驶，
 * 验证信号系统在密集运行下的安全性与服务完整性。
 */
describe('车队浸泡（5 分钟，12 车全自动）', () => {
  it('零紧急制动、零碰撞、零非法溜车、速度不超限', () => {
    const world = new World();
    const ai = new AiDriver();
    const steps = Math.round(300 / CONFIG.sim.dt);

    let minBumperGap = Infinity;
    let ebCount = 0;
    let maxIllegalReverse = 0;
    let maxSpeed = 0;
    const prevEb = new Set<number>();

    for (let i = 0; i < steps; i++) {
      const auth = world.signals.authorityFor(world.player);
      world.player.input = ai.decide(
        world.line,
        world.player,
        supervisedSpeed(world.line, world.player, auth),
      );
      world.step();

      for (const tr of world.trains) {
        if (!Number.isFinite(tr.s) || !Number.isFinite(tr.v)) throw new Error('状态出现 NaN');
        maxSpeed = Math.max(maxSpeed, Math.abs(tr.v));
        if (tr.v < 0 && !tr.input.reverseMode) maxIllegalReverse = Math.max(maxIllegalReverse, -tr.v);
        if (tr.emergencyApplied && !prevEb.has(tr.id)) {
          ebCount++;
          prevEb.add(tr.id);
        }
        if (!tr.emergencyApplied) prevEb.delete(tr.id);
      }

      // 空间排序后的相邻车保险杠间隙
      const sorted = [...world.trains].sort((a, b) => a.s - b.s);
      for (let k = 0; k < sorted.length; k++) {
        const a = sorted[k];
        const b = sorted[(k + 1) % sorted.length];
        const headway = (b.s - a.s + world.line.length) % world.line.length;
        minBumperGap = Math.min(minBumperGap, headway - CONFIG.train.length);
      }
    }

    expect(ebCount).toBe(0);
    expect(minBumperGap).toBeGreaterThan(0);
    expect(maxIllegalReverse).toBeLessThan(0.1);
    expect(maxSpeed).toBeLessThanOrEqual(CONFIG.train.maxSpeed + 0.5);
  });

  it('每列车都能完成至少一次 ±30cm 对标停车并联动开关门', () => {
    const world = new World();
    const ai = new AiDriver();
    // 环线一圈约 41km、站站停车，给足 20 分钟
    const steps = Math.round(1200 / CONFIG.sim.dt);    const aligned = new Set<number>();
    const maxErrors: number[] = [];

    for (let i = 0; i < steps; i++) {
      const auth = world.signals.authorityFor(world.player);
      world.player.input = ai.decide(
        world.line,
        world.player,
        supervisedSpeed(world.line, world.player, auth),
      );
      world.step();
      for (const tr of world.trains) {
        if (tr.stopStatus === 'aligned' && !aligned.has(tr.id)) {
          aligned.add(tr.id);
          if (tr.stopError !== null) maxErrors.push(Math.abs(tr.stopError));
          expect(tr.psdOpen).toBe(true);
        }
      }
    }

    expect(aligned.size).toBe(CONFIG.line.trainCount);
    expect(Math.max(...maxErrors)).toBeLessThanOrEqual(CONFIG.station.stopTolerance);
  });
});
