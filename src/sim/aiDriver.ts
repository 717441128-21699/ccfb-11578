import {
  BRAKE_NOTCHES,
  POWER_NOTCHES,
} from './constants';
import type { Line } from './line';
import { speedLimitAt } from './line';
import type { SignalSystem } from './signaling';
import type { Train } from './train';
import type { DriverInput, TrainEvent } from './types';

/**
 * Automatic train operation for the 11 non-player trains.
 * Targets the lower of the line limit and the ATP warning curve, then uses a
 * simple brake-distance controller to choose notches.
 */
export class AiDriver {
  drive(train: Train, line: Line, signals: SignalSystem): { input: DriverInput; events: TrainEvent[] } {
    const events: TrainEvent[] = [];
    const input: DriverInput = {
      power: 0,
      brake: 0,
      reverser: train.reverser,
      ebButton: false,
      targetDecel: null,
    };

    // Emergency brake: acknowledge automatically once release is permitted.
    if (train.atp.awaitConfirm) events.push('confirm');
    if (train.ebPenalty && Math.abs(train.speed) <= 0.3) events.push('confirm');

    // Dwell: close doors as soon as regulation allows, then let the train resume.
    if (train.phase === 'dwell') {
      if (train.doorsOpen && train.doorsOpenTimer >= 10) events.push('closeDoors');
      train.tryResume(line);
      return { input, events };
    }

    if (train.phase === 'turnback') return { input, events };

    // Overshoot rollback is only valid while stationary after a genuine
    // overshoot. Never reverse a moving train.
    if (
      train.overshoot &&
      train.rollbackRemaining === null &&
      !train.failedStop &&
      Math.abs(train.speed) <= 0.3
    ) {
      events.push('rollback');
    }
    if (train.rollbackRemaining !== null) {
      input.reverser = (-train.direction) as -1 | 1;
      if (Math.abs(train.speed) < 4 / 3.6) input.power = 1;
      return { input, events };
    }

    const snap = train.snapshot();
    const absSpeed = Math.abs(train.speed);
    const targetSpeed = this.targetSpeed(train, line, signals);
    const margin = targetSpeed - absSpeed;

    // Distance-based braking to the next zero-speed target (station / authority end).
    const stopTarget = this.stopDistance(snap.atp.targets);
    const neededDecel = stopTarget !== null && absSpeed > 0.5
      ? (absSpeed * absSpeed) / (2 * Math.max(1, stopTarget))
      : 0;

    if (neededDecel > 0.55 || margin < -1.0) {
      const strength = Math.max(neededDecel / 1.1, Math.min(1, -margin / 6 + 0.35));
      input.brake = clamp(Math.round(strength * BRAKE_NOTCHES), 1, BRAKE_NOTCHES);
    } else if (margin > 1.2 && absSpeed < MAX_CREEP) {
      input.power = POWER_NOTCHES;
    } else if (margin > 0.6) {
      input.power = clamp(Math.ceil(margin), 1, POWER_NOTCHES - 1);
    }
    // Otherwise coast.

    return { input, events };
  }

  private targetSpeed(train: Train, line: Line, signals: SignalSystem): number {
    const limit = speedLimitAt(line, train.front);
    const signal = signals.nextSignal(train.trackId, train.front, train.direction);
    let signalLimit = limit;
    if (signal && signal.aspect === 'yellow') signalLimit = Math.min(limit, 45 / 3.6);
    if (signal && signal.aspect === 'red') signalLimit = 0;

    const warn = train.snapshot().atp.warnSpeed;
    return Math.max(0, Math.min(limit, signalLimit, Number.isFinite(warn) ? warn - 1.0 : limit));
  }

  /** Travel distance to the nearest zero-speed supervision target. */
  private stopDistance(targets: readonly { s: number; v: number }[]): number | null {
    for (const t of targets) {
      if (t.v === 0 && t.s > 0) return t.s;
    }
    return null;
  }
}

const MAX_CREEP = 70 / 3.6;

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}
