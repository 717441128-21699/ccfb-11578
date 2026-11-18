import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { CONFIG } from '../src/sim/config';
import { blockIndexAt } from '../src/sim/line';

function run(world: World, seconds: number): void {
  const steps = Math.round(seconds / CONFIG.sim.dt);
  for (let i = 0; i < steps; i++) world.step();
}

describe('仿真世界集成', () => {
  it('120Hz 步进：12 列车全部在线且占用分区不冲突', () => {
    const world = new World();
    run(world, 5);
    expect(world.trains).toHaveLength(12);

    const owner = new Map<number, number>();
    for (const tr of world.trains) {
      const head = blockIndexAt(world.line, tr.s);
      const tail = blockIndexAt(world.line, tr.s - CONFIG.train.length);
      let i = tail;
      const n = world.line.blocks.length;
      let guard = 0;
      while (guard++ < n + 2) {
        const existing = owner.get(i);
        expect(existing === undefined || existing === tr.id).toBe(true);
        owner.set(i, tr.id);
        if (i === head) break;
        i = (i + 1) % n;
      }
    }
  });

  it('AI 列车自动运行不停在区间、速度不超过 ATP 监督速度+EB余量', () => {
    const world = new World();
    run(world, 120);
    for (const tr of world.trains) {
      expect(tr.emergencyApplied).toBe(false);
      expect(Math.abs(tr.v)).toBeLessThanOrEqual(
        tr.supervisedSpeed + CONFIG.atp.ebMargin + 0.05,
      );
    }
  });

  it('红灯场景：前车区间紧急停车，后车被 ATP 拦下且不追尾', () => {
    const world = new World();
    // 让前车跑一会儿再触发障碍
    run(world, 60);
    const leader = world.trains[1];
    const initialGap = world.player.authorityDistance;
    expect(initialGap).toBeGreaterThan(0);

    leader.emergencyApplied = true;
    leader.input.emergencyBrake = true;
    leader.input.tractionNotch = 0;

    // 玩家全速冲向红灯
    world.player.input.tractionNotch = 1;
    world.player.input.brakeNotch = 0;
    run(world, 90);

    // 玩家必然被 ATP 施加过紧急制动
    expect(world.player.atpEmergency || world.player.emergencyApplied).toBe(true);
    // 最终停稳
    expect(Math.abs(world.player.v)).toBeLessThan(0.2);
    // 授权终点始终在车头前方（没越过）
    expect(world.player.authorityDistance).toBeGreaterThanOrEqual(0);
    // 两列车实际间隔至少一个车长量级
    const gap =
      (leader.s - world.player.s + world.line.length) % world.line.length;
    expect(gap).toBeGreaterThan(CONFIG.train.length);
  });

  it('紧急制动必须停稳确认才能缓解', () => {
    const world = new World();
    const p = world.player;
    p.emergencyApplied = true;
    p.input.emergencyBrake = true;
    run(world, 2);
    // 未确认：保持施加
    expect(p.emergencyApplied).toBe(true);

    // 运行中确认无效（未停稳）
    p.ebAck = true;
    p.v = 8;
    run(world, 1);
    expect(p.emergencyApplied).toBe(true);

    // 停稳后确认 -> 缓解
    p.v = 0;
    p.ebAck = true;
    run(world, 1);
    expect(p.emergencyApplied).toBe(false);
    expect(p.input.emergencyBrake).toBe(false);
  });

  it('站台对标：停在 ±30cm 内开门并联动屏蔽门，停过标需退行', () => {
    // 对齐场景：全新世界，玩家初始即在 station 0 停车标
    const world = new World();
    const p = world.player;

    run(world, 1);
    expect(p.stopStatus).toBe('aligned');
    expect(p.doorsOpen).toBe(true);
    expect(p.psdOpen).toBe(true);

    // 停站结束自动关门
    run(world, CONFIG.station.dwellSeconds + 1);
    expect(p.doorsOpen).toBe(false);
    expect(p.psdOpen).toBe(false);

    // 越标场景：另一全新世界，直接放到停车标前方 5m 处停稳
    const world2 = new World();
    const q = world2.player;
    const stn = world2.line.stations[0];
    q.s = stn.stopS + 5;
    q.v = 0;
    // 清除构造后首步产生的停站状态
    q.stopStatus = 'none';
    q.stopError = null;
    q.dwellComplete = false;
    q.doorsOpen = false;
    q.input.doorsOpen = false;
    q.psdOpen = false;
    run(world2, 1);
    expect(q.stopStatus).toBe('overshoot');
    expect(q.psdOpen).toBe(false);
    expect(q.reversePermitted).toBe(true);

    // 退行 5m 回到窗口内并停稳 -> 重新判定为对齐、开门
    q.s = stn.stopS + 0.1;
    q.v = 0;
    run(world2, 1);
    expect(q.stopStatus).toBe('aligned');
    expect(q.psdOpen).toBe(true);
  });

  it('载荷影响同手柄减速度：满载减速更慢', () => {
    const world = new World();
    const decelFor = (load: 'AW0' | 'AW3') => {
      const p = world.player;
      p.load = load;
      p.mass = load === 'AW3' ? CONFIG.train.massFull : CONFIG.train.massEmpty;
      p.s = 5000;
      p.v = 18;
      p.tractionForce = 0;
      p.edBrakeForce = 0;
      p.airBrakeForce = 0;
      p.emergencyForce = 0;
      p.emergencyApplied = false;
      p.input.tractionNotch = 0;
      p.input.brakeNotch = 0.6;
      p.input.doorsOpen = false;
      const v0 = p.v;
      run(world, 2);
      return v0 - p.v;
    };
    const fullDrop = decelFor('AW3');
    const emptyDrop = decelFor('AW0');
    expect(emptyDrop).toBeGreaterThan(fullDrop);
  });
});
