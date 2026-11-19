import {
  ATP_GUARANTEE_DECEL,
  ATP_LOOK_AHEAD,
  ATP_WARN_FACTOR,
  LINE_END_MARGIN,
  STANDSTILL_SPEED,
  EB_STOPPED_HOLD,
} from './constants';
import type { Line } from './line';
import { minSpeedAhead, speedLimitAt } from './line';
import type { MovementAuthority, TrainEvent } from './types';

export type BrakeTargetReason = 'ma' | 'limit' | 'station' | 'lineEnd';

export interface BrakeTarget {
  /** Travel coordinate (metres ahead of the train) where target speed applies. */
  s: number;
  /** Speed that must not be exceeded at s. */
  v: number;
  reason: BrakeTargetReason;
}

export interface AtpSnapshot {
  alarm: boolean;
  emergencyActive: boolean;
  /** EB has been applied, train is stopped and the driver acknowledgement is now required. */
  awaitConfirm: boolean;
  /** Current supervision speed for the warning curve (m/s). */
  warnSpeed: number;
  /** Current supervision speed for the emergency curve (m/s). */
  emergencySpeed: number;
  /** Speed limit of the line at the train's current position (m/s). */
  lineLimit: number;
  targets: BrakeTarget[];
  ma: MovementAuthority;
}

interface AtpState {
  alarm: boolean;
  emergencyActive: boolean;
  awaitConfirm: boolean;
  stoppedTime: number;
  warnSpeed: number;
  emergencySpeed: number;
  targets: BrakeTarget[];
  /** After a driver-acknowledged release, supervision is suppressed until the
   *  driver starts moving again while back under the live curve. */
  inhibited: boolean;
}

export class AtpController {
  private state: AtpState = {
    alarm: false,
    emergencyActive: false,
    awaitConfirm: false,
    stoppedTime: 0,
    warnSpeed: Infinity,
    emergencySpeed: Infinity,
    targets: [],
    inhibited: false,
  };

  get emergencyActive(): boolean {
    return this.state.emergencyActive;
  }

  get alarm(): boolean {
    return this.state.alarm;
  }

  get awaitConfirm(): boolean {
    return this.state.awaitConfirm;
  }

  handleEvent(event: TrainEvent): void {
    if (event === 'confirm' && this.state.awaitConfirm) {
      this.state.emergencyActive = false;
      this.state.awaitConfirm = false;
      this.state.stoppedTime = 0;
      this.state.alarm = false;
      // Re-arm only after the driver moves again while under the live curve.
      this.state.inhibited = true;
    }
  }

  /** External penalty reset (e.g. rollback overspeed) uses the same gate. */
  resetPenalty(): void {
    this.state.inhibited = false;
  }

  /**
   * Build the ordered set of brake-curve targets in the train's own travel
   * coordinate (0 = current front position, increasing ahead).
   */
  buildTargets(
    line: Line,
    front: number,
    direction: 1 | -1,
    ma: MovementAuthority,
    includeStationStop: boolean,
    nextStationChainage: number | null,
  ): BrakeTarget[] {
    const targets: BrakeTarget[] = [];
    const toTravel = (chainage: number): number => (chainage - front) * direction;

    // Authority end -> zero speed.
    if (ma.valid) {
      const s = toTravel(ma.endChainage);
      if (s > 0 && s < ATP_LOOK_AHEAD) {
        targets.push({ s, v: 0, reason: 'ma' });
      }
    }

    // Physical line end.
    const endChainage = direction > 0 ? line.length - LINE_END_MARGIN : LINE_END_MARGIN;
    const sEnd = toTravel(endChainage);
    if (sEnd > 0 && sEnd < ATP_LOOK_AHEAD) {
      targets.push({ s: sEnd, v: 0, reason: 'lineEnd' });
    }

    // Every permanent speed restriction ahead becomes a target at its start.
    for (const seg of line.speedSegments) {
      const boundary = direction > 0 ? seg.start : seg.end;
      const s = toTravel(boundary);
      if (s <= 0 || s >= ATP_LOOK_AHEAD) continue;
      const ahead = minSpeedAhead(line, boundary, boundary + 5);
      const here = speedLimitAt(line, front);
      if (ahead < here - 0.5) {
        targets.push({ s, v: ahead, reason: 'limit' });
      }
    }

    // Station stop is supervised only for automatic trains; the human driver
    // owns platform stopping and gets the block-authority curve instead.
    if (includeStationStop && nextStationChainage !== null) {
      const s = toTravel(nextStationChainage);
      if (s > 0 && s < ATP_LOOK_AHEAD) {
        targets.push({ s, v: 0, reason: 'station' });
      }
    }

    targets.sort((a, b) => a.s - b.s);
    return targets;
  }

  /**
   * Supervision speed at travel coordinate s for a guaranteed deceleration:
   * the tightest of all constant-decel curves v^2 = vTarget^2 + 2 a d.
   */
  static supervisionSpeed(targets: readonly BrakeTarget[], s: number, decel: number): number {
    let result = Infinity;
    for (const t of targets) {
      const d = t.s - s;
      if (d <= 0) {
        result = Math.min(result, t.v);
        continue;
      }
      result = Math.min(result, Math.sqrt(t.v * t.v + 2 * decel * d));
    }
    return result;
  }

  update(
    dt: number,
    args: {
      line: Line;
      front: number;
      speed: number; // signed
      direction: 1 | -1;
      ma: MovementAuthority;
      autoPilot: boolean;
      nextStationChainage: number | null;
    },
  ): AtpSnapshot {
    const { line, front, speed, direction, ma } = args;
    const absSpeed = Math.abs(speed);
    const st = this.state;

    if (st.emergencyActive) {
      // Keep the supervision curve live even during EB, so release inhibition
      // compares against the curve at the current position.
      st.targets = this.buildTargets(
        line,
        front,
        direction,
        ma,
        args.autoPilot,
        args.nextStationChainage,
      );
      st.emergencySpeed = AtpController.supervisionSpeed(st.targets, 0, ATP_GUARANTEE_DECEL);
      st.warnSpeed = AtpController.supervisionSpeed(
        st.targets,
        0,
        ATP_GUARANTEE_DECEL * ATP_WARN_FACTOR,
      );
      // Release path: hold EB until the train is stopped and the driver confirms.
      if (absSpeed <= STANDSTILL_SPEED) {
        st.stoppedTime += dt;
        if (st.stoppedTime >= EB_STOPPED_HOLD) st.awaitConfirm = true;
      } else {
        st.stoppedTime = 0;
        st.awaitConfirm = false;
      }
    } else {
      st.targets = this.buildTargets(
        line,
        front,
        direction,
        ma,
        args.autoPilot,
        args.nextStationChainage,
      );
      const vEb = AtpController.supervisionSpeed(st.targets, 0, ATP_GUARANTEE_DECEL);
      const vWarn = AtpController.supervisionSpeed(
        st.targets,
        0,
        ATP_GUARANTEE_DECEL * ATP_WARN_FACTOR,
      );
      const lineLimit = speedLimitAt(line, front);
      st.emergencySpeed = Math.min(vEb, lineLimit);
      st.warnSpeed = Math.min(vWarn, lineLimit);

      if (st.inhibited && absSpeed > STANDSTILL_SPEED && absSpeed <= st.emergencySpeed) {
        st.inhibited = false;
      }

      st.alarm = !st.inhibited && absSpeed > st.warnSpeed;
      if (
        !st.inhibited &&
        (absSpeed > st.emergencySpeed || (!ma.valid && absSpeed > STANDSTILL_SPEED))
      ) {
        st.emergencyActive = true;
        st.stoppedTime = 0;
        st.awaitConfirm = false;
        st.alarm = true;
      }
    }

    return {
      alarm: st.alarm,
      emergencyActive: st.emergencyActive,
      awaitConfirm: st.awaitConfirm,
      warnSpeed: st.warnSpeed,
      emergencySpeed: st.emergencySpeed,
      lineLimit: speedLimitAt(line, front),
      targets: st.targets,
      ma,
    };
  }

  snapshot(ma: MovementAuthority, line: Line, front: number): AtpSnapshot {
    return {
      alarm: this.state.alarm,
      emergencyActive: this.state.emergencyActive,
      awaitConfirm: this.state.awaitConfirm,
      warnSpeed: this.state.warnSpeed,
      emergencySpeed: this.state.emergencySpeed,
      lineLimit: speedLimitAt(line, front),
      targets: this.state.targets,
      ma,
    };
  }
}
