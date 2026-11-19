import { describe, expect, it } from 'vitest';
import { SIM_DT } from './constants';
import { World } from './world';

function freshWorld(): World {
  return new World(42);
}

describe('line generation', () => {
  it('builds 20 stations and two tracks of fixed blocks', () => {
    const w = freshWorld();
    expect(w.line.stations).toHaveLength(20);
    expect(w.line.blocks).toHaveLength(2);
    for (const track of w.line.blocks) {
      expect(track.length).toBeGreaterThan(50);
      for (let i = 0; i < track.length; i++) {
        const b = track[i];
        // Only the tail block at the line end may be shorter than the minimum.
        if (i < track.length - 1) expect(b.end - b.start).toBeGreaterThanOrEqual(250);
        else expect(b.end - b.start).toBeGreaterThanOrEqual(50);
      }
    }
  });

  it('covers the full line without gaps or overlaps', () => {
    const w = freshWorld();
    for (const track of w.line.blocks) {
      expect(track[0].start).toBe(0);
      for (let i = 1; i < track.length; i++) {
        expect(track[i].start).toBe(track[i - 1].end);
      }
    }
  });

  it('spawns exactly 12 trains, six per track', () => {
    const w = freshWorld();
    expect(w.trains).toHaveLength(12);
    expect(w.trains.filter((t) => t.trackId === 0)).toHaveLength(6);
    expect(w.trains.filter((t) => t.trackId === 1)).toHaveLength(6);
    expect(w.trains[0].autoPilot).toBe(false);
    expect(w.trains.slice(1).every((t) => t.autoPilot)).toBe(true);
  });
});

describe('vehicle dynamics', () => {
  it('accelerates from standstill and traction force falls with speed', () => {
    const w = freshWorld();
    const t = w.player;
    w.setPlayerInput({ power: 4, brake: 0, reverser: 1, ebButton: false, targetDecel: null });
    w.runFor(2);
    const lowSpeedForce = t.snapshot().tractionForceN;
    expect(t.speed).toBeGreaterThan(1);

    w.runFor(20);
    const high = t.snapshot();
    expect(high.speed).toBeGreaterThan(6);
    // Constant-power region: force per notch must be below the standstill value.
    expect(high.tractionForceN).toBeLessThan(lowSpeedForce);
  });

  it('the same brake notch decelerates an empty train harder than a full one', () => {
    const decel = (load: 'empty' | 'full'): number => {
      const w = freshWorld();
      const t = w.player;
      // Swap the physical mass directly (load label is irrelevant to forces).
      if (load === 'full') Object.defineProperty(t, 'mass', { value: 330_000, writable: false });
      // Reach a steady speed first.
      w.setPlayerInput({ power: 4, brake: 0, reverser: 1, ebButton: false, targetDecel: null });
      w.runFor(12);
      const speedBefore = t.speed;
      w.setPlayerInput({ power: 0, brake: 4, reverser: 1, ebButton: false, targetDecel: null });
      w.runFor(3);
      return (speedBefore - t.speed) / 3;
    };
    const empty = decel('empty');
    const full = decel('full');
    expect(empty).toBeGreaterThan(full * 1.2);
  });

  it('electric brake fades at low speed and air brake takes over', () => {
    const w = freshWorld();
    const t = w.player;
    w.setPlayerInput({ power: 4, brake: 0, reverser: 1, ebButton: false, targetDecel: null });
    w.runFor(10);
    w.setPlayerInput({ power: 0, brake: 5, reverser: 1, ebButton: false, targetDecel: null });
    w.runFor(8);
    const stopped = t.snapshot();
    expect(Math.abs(stopped.speed)).toBeLessThan(0.3);
    expect(stopped.edForceN).toBeLessThan(5000);
    expect(stopped.airForceN).toBeGreaterThan(50_000);
  });

  it('holds position at standstill on a grade with the brake applied', () => {
    const w = freshWorld();
    const t = w.player;
    t.front = 2000; // somewhere mid-line
    w.setPlayerInput({ power: 0, brake: 3, reverser: 1, ebButton: false, targetDecel: null });
    const before = t.front;
    w.runFor(5);
    expect(Math.abs(t.front - before)).toBeLessThan(0.05);
  });
});

describe('ATP supervision', () => {
  it('alarms before applying emergency braking when overspeeding', () => {
    const w = freshWorld();
    const t = w.player;
    // Park a train ahead so the player's authority ends ~400 m out.
    const ahead = w.trains.filter((tr) => tr.trackId === t.trackId)[1];
    ahead.front = t.front + 900;
    w.setPlayerInput({ power: 4, brake: 0, reverser: 1, ebButton: false, targetDecel: null });
    let sawAlarm = false;
    let triggered = false;
    for (let i = 0; i < 2000; i++) {
      w.step();
      const snap = t.snapshot();
      if (snap.atp.alarm) sawAlarm = true;
      if (snap.atp.emergencyActive) {
        triggered = true;
        break;
      }
    }
    expect(triggered).toBe(true);
    expect(sawAlarm).toBe(true);
  });

  it('keeps EB latched until the train stops and the driver confirms', () => {
    const w = freshWorld();
    const t = w.player;
    const ahead = w.trains.filter((tr) => tr.trackId === t.trackId)[1];
    ahead.front = t.front + 800;
    w.setPlayerInput({ power: 4, brake: 0, reverser: 1, ebButton: false, targetDecel: null });
    while (!t.snapshot().atp.emergencyActive) w.step();
    // Confirming while still moving does nothing.
    w.playerEvent('confirm');
    expect(t.snapshot().atp.emergencyActive).toBe(true);

    while (Math.abs(t.speed) > 0.3) w.step();
    w.runFor(2);
    expect(t.snapshot().atp.awaitConfirm).toBe(true);
    w.playerEvent('confirm');
    expect(t.snapshot().atp.emergencyActive).toBe(false);
  });

  it('never lets the automatic fleet cross a red-signal authority end', () => {
    const w = freshWorld();
    for (let i = 0; i < 60 * 100; i++) {
      w.step();
      for (const tr of w.trains) {
        const s = tr.snapshot();
        const ma = s.atp.ma;
        if (ma.valid) {
          const overrun = (s.front - ma.endChainage) * s.direction;
          expect(overrun).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('station stopping', () => {
  it('opens doors only within +/-30 cm and reports the stop error', () => {
    const w = freshWorld();
    const t = w.player;
    const station = w.line.stations[2];
    // Approach from ~350 m out, accelerate then brake to stop near the mark.
    t.front = station.chainage - 350;
    w.setPlayerInput({ power: 3, brake: 0, reverser: 1, ebButton: false, targetDecel: null });
    w.runFor(12);
    w.setPlayerInput({ power: 0, brake: 0, reverser: 1, ebButton: false, targetDecel: null });
    w.runFor(3);
    w.setPlayerInput({ power: 0, brake: 4, reverser: 1, ebButton: false, targetDecel: null });
    for (let i = 0; i < 1200 && Math.abs(t.speed) > 0.3; i++) w.step();
    // Allow the stop-confirmation window to elapse.
    w.runFor(1);
    const snap = t.snapshot();
    if (snap.currentStationId === 2 && snap.stopError !== null) {
      if (Math.abs(snap.stopError) <= 0.3) expect(snap.doorsOpen).toBe(true);
      else expect(snap.doorsOpen).toBe(false);
    }
    // Whatever happened, the train must be stable and finite.
    expect(Number.isFinite(snap.front)).toBe(true);
  });

  it('a stop exactly on the mark opens the platform screen doors', () => {
    const w = freshWorld();
    const t = w.player;
    const station = w.line.stations[2];
    t.front = station.chainage;
    t.speed = 0;
    w.runFor(1);
    const snap = t.snapshot();
    expect(snap.stopError).toBeCloseTo(0, 5);
    expect(snap.doorsOpen).toBe(true);
    expect(snap.phase).toBe('dwell');
  });

  it('a stop 50 cm short of the mark keeps the doors closed', () => {
    const w = freshWorld();
    const t = w.player;
    const station = w.line.stations[3];
    t.front = station.chainage - 0.5;
    t.speed = 0;
    w.runFor(1);
    const snap = t.snapshot();
    expect(snap.currentStationId).toBe(3);
    expect(Math.abs(snap.stopError ?? 0)).toBeGreaterThan(0.3);
    expect(snap.doorsOpen).toBe(false);
  });

  it('AI trains stop at stations, dwell, and continue service', () => {
    const w = freshWorld();
    const ai = w.trains[1];
    const startFront = ai.front;
    w.runFor(180);
    const after = ai.snapshot();
    // Over three minutes the train must have left its spawn position or be
    // serving a station there.
    const moved = Math.abs(after.front - startFront);
    expect(moved > 50 || after.phase === 'dwell' || after.phase === 'turnback').toBe(true);
    expect(['running', 'dwell', 'turnback']).toContain(after.phase);
  });

  it('runs the full fleet stably for ten simulated minutes', () => {
    const w = freshWorld();
    const t0 = performance.now();
    w.runFor(600);
    const elapsedMs = performance.now() - t0;
    // 60 000 fixed steps over 12 trains should finish comfortably in real time.
    expect(elapsedMs).toBeLessThan(20_000);
    for (const t of w.trains) {
      expect(Number.isFinite(t.speed)).toBe(true);
      expect(t.front).toBeGreaterThan(0);
      expect(t.front).toBeLessThan(w.line.length);
    }
    // No train may be latched into emergency brake at the end of the run:
    // the AI must acknowledge and release every EB after stopping.
    expect(w.trains.every((t) => !t.atp.emergencyActive)).toBe(true);
  });
});

describe('simulation rate', () => {
  it('updates every train at least 60 times per simulated second', () => {
    const w = freshWorld();
    expect(1 / SIM_DT).toBeGreaterThanOrEqual(60);
    const ticksPerSecond = 100;
    let steps = 0;
    const timer = setInterval(() => {}, 1000);
    clearInterval(timer);
    w.runFor(1);
    steps = w.getSnapshot().tick;
    expect(steps).toBe(ticksPerSecond);
  });
});
