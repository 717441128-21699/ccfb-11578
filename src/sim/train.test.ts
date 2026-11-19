import { describe, expect, it } from 'vitest';
import { EMPTY_MASS, FULL_LOAD_MASS } from './constants';
import { Train, type TrainConfig } from './train';
import { World } from './world';

function makeTrain(load: 'empty' | 'full'): Train {
  const w = new World(1);
  const config: TrainConfig = {
    id: 99,
    label: 'T99',
    trackId: 0,
    direction: 1,
    front: 5000,
    load,
    autoPilot: false,
  };
  const t = new Train(config);
  t.initialize(w.line, w.signals);
  return t;
}

describe('load-dependent braking', () => {
  it('gives an empty and full train different masses', () => {
    expect(makeTrain('empty').mass).toBe(EMPTY_MASS);
    expect(makeTrain('full').mass).toBe(EMPTY_MASS + FULL_LOAD_MASS);
  });

  it('brakes the empty train harder than the full train at the same notch', () => {
    const decel = (load: 'empty' | 'full'): number => {
      const w = new World(1);
      const t = makeTrain(load);
      // Inject into the world so stepping updates occupancy/authority.
      (w as unknown as { trains: Train[] }).trains = [t];
      w.signals.clear();
      w.signals.markOccupied(0, t.occupiedBlockIds);
      t.setInput({ power: 4, brake: 0, reverser: 1, ebButton: false, targetDecel: null });
      w.runFor(10);
      const v0 = t.speed;
      t.setInput({ power: 0, brake: 5, reverser: 1, ebButton: false, targetDecel: null });
      w.runFor(3);
      return (v0 - t.speed) / 3;
    };
    const emptyDecel = decel('empty');
    const fullDecel = decel('full');
    expect(emptyDecel).toBeGreaterThan(fullDecel * 1.15);
  });
});
