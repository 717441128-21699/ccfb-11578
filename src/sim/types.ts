/**
 * Shared simulation type definitions.
 * All longitudinal positions are chainages (metres along the track centre
 * line), increasing from station 0 toward station 19.
 */

export type Direction = 1 | -1;
export type TrackId = 0 | 1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface StationDef {
  id: number;
  name: string;
  /** Chainage of the stopping mark (train front must stop here). */
  chainage: number;
  platformLength: number;
}

export interface BlockDef {
  id: number;
  trackId: TrackId;
  /** Chainage interval, always start < end regardless of travel direction. */
  start: number;
  end: number;
  /** Station whose stopping mark lies inside this block, if any. */
  stationId: number | null;
}

export interface GradePoint {
  chainage: number;
  /** Rise over run, e.g. 0.012 = +1.2 %. Positive = uphill toward higher chainage. */
  grade: number;
}

export interface CurvePoint {
  chainage: number;
  /** Curve radius in m; signed (left/right); Infinity on tangent. */
  radius: number;
}

export interface SpeedPoint {
  chainage: number;
  /** Permanent line speed limit from this chainage onward (m/s). */
  speed: number;
}

export type TrainPhase = 'running' | 'dwell' | 'turnback';

export type TrainEvent = 'confirm' | 'closeDoors' | 'rollback';

/** Per-tick driver intent. Held controls are plain fields, one-shot actions go through events. */
export interface DriverInput {
  /** Traction notch 0..4. */
  power: number;
  /** Brake notch 0..7 (ignored while targetDecel is set, which is AI only). */
  brake: number;
  /** Reverser: 1 forward, 0 neutral, -1 reverse. */
  reverser: -1 | 0 | 1;
  /** Driver-requested emergency brake push button (latch toggle handled by train). */
  ebButton: boolean;
  /**
   * Continuous deceleration target (m/s^2) used by the AI driver; the player
   * only gets discrete brake notches. null = not used.
   */
  targetDecel: number | null;
}

export interface MovementAuthority {
  /** Chainage the train must not pass. */
  endChainage: number;
  /** Distance from the train front to the authority end (m). */
  distance: number;
  valid: boolean;
}
