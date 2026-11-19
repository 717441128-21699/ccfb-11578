import {
  AIR_FILL_TAU,
  AIR_MAX_FORCE,
  AIR_RELEASE_TAU,
  BRAKE_NOTCHES,
  BRAKE_TOTAL_FORCE,
  CAR_COUNT,
  CURVE_RESIST_COEFF,
  DAVIS_A,
  DAVIS_B,
  DAVIS_C,
  DWELL_TIME,
  EB_DECEL,
  EB_FORCE,
  ED_FADEOUT_SPEED,
  ED_FULL_SPEED,
  ED_MAX_FORCE,
  ED_TAU,
  EMPTY_MASS,
  FULL_LOAD_MASS,
  G,
  MAX_TRACTIVE_FORCE,
  MAX_TRACTIVE_POWER,
  MIN_DOORS_OPEN_TIME,
  POWER_NOTCHES,
  ROLLBACK_MAX_DISTANCE,
  ROTATIONAL_FACTOR,
  SIM_DT,
  STANDSTILL_SPEED,
  STOP_CONFIRM_TIME,
  TRACTION_BUILD_TAU,
  TRACTION_RELEASE_TAU,
  TRAIN_LENGTH,
  TURNBACK_TIME,
} from './constants';
import { AtpController, type AtpSnapshot } from './atp';
import type { Line } from './line';
import { blockAt, curveAt, gradeAt } from './line';
import type { SignalSystem } from './signaling';
import type {
  BlockDef,
  Direction,
  DriverInput,
  MovementAuthority,
  TrainEvent,
  TrainPhase,
  TrackId,
} from './types';

export type LoadLevel = 'empty' | 'half' | 'full';

export interface TrainConfig {
  id: number;
  label: string;
  trackId: TrackId;
  direction: Direction;
  /** Chainage of the train FRONT at spawn. */
  front: number;
  load: LoadLevel;
  autoPilot: boolean;
}
export interface TrainSnapshot {
  id: number;
  label: string;
  trackId: TrackId;
  front: number;
  rear: number;
  speed: number;
  acceleration: number;
  direction: Direction;
  reverser: -1 | 0 | 1;
  phase: TrainPhase;
  doorsOpen: boolean;
  load: LoadLevel;
  mass: number;
  autoPilot: boolean;
  occupiedBlockIds: number[];
  atp: AtpSnapshot;
  tractionForceN: number;
  edForceN: number;
  airForceN: number;
  grade: number;
  curveRadius: number;
  // platform interaction
  currentStationId: number | null;
  stopError: number | null;
  doorsOpenTimer: number;
  dwellRemaining: number;
  overshoot: boolean;
  failedStop: boolean;
  rollbackRemaining: number | null;
  ebCounter: number;
  distanceTravelled: number;
}

const LOAD_FRACTION: Record<LoadLevel, number> = { empty: 0, half: 0.5, full: 1 };

/** First-order lag, stable at the fixed 100 Hz step. */
function lag(current: number, target: number, tau: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export class Train {
  readonly id: number;
  readonly label: string;
  readonly trackId: TrackId;
  readonly autoPilot: boolean;

  direction: Direction;
  reverser: -1 | 0 | 1 = 1;
  front: number;
  speed = 0; // signed along increasing chainage
  acceleration = 0;

  load: LoadLevel;
  readonly mass: number;

  phase: TrainPhase = 'running';
  doorsOpen = false;
  doorsOpenTimer = 0;
  dwellRemaining = 0;
  currentStationId: number | null = null;
  stopError: number | null = null;
  overshoot = false;
  failedStop = false;
  rollbackRemaining: number | null = null;
  turnbackTimer = 0;

  // Driver demand
  powerNotch = 0;
  brakeNotch = 0;
  ebButton = false;
  /** Latched when a manoeuvre violates its speed limit; cleared by confirm after stopping. */
  ebPenalty = false;

  // Actuator states (forces in N, magnitudes)
  private tractionForce = 0;
  private edForce = 0;
  private airForce = 0;
  /** Consecutive time spent under the standstill threshold, for stop confirmation. */
  private stoppedTimer = 0;
  /** Latch: parking brake is holding the train at rest until traction arrives. */
  private parkingHeld = false;

  readonly atp = new AtpController();
  private ma: MovementAuthority = { endChainage: 0, distance: 0, valid: false };
  private occupiedBlocks: BlockDef[] = [];
  private lastAtp: AtpSnapshot | null = null;
  private lastGrade = 0;
  private lastCurve = Infinity;
  private lastLine: Line | null = null;

  /** Populate ATP snapshot and occupancy before the first real step. */
  initialize(line: Line, signals: import('./signaling').SignalSystem): void {
    this.occupiedBlocks = this.blocksCovered(line);
    const frontBlock = this.occupiedBlocks[this.occupiedBlocks.length - 1] ?? null;
    const ma = signals.authorityFor(this.trackId, frontBlock, this.direction, this.front);
    this.lastAtp = this.atp.update(SIM_DT, {
      line,
      front: this.front,
      speed: this.speed,
      direction: this.direction,
      ma,
      autoPilot: this.autoPilot,
      nextStationChainage: this.nextStationStop(line),
    });
    this.lastLine = line;
  }

  private ebCounter = 0;
  private distanceTravelled = 0;

  constructor(config: TrainConfig) {
    this.id = config.id;
    this.label = config.label;
    this.trackId = config.trackId;
    this.direction = config.direction;
    this.reverser = config.direction;
    this.front = config.front;
    this.load = config.load;
    this.autoPilot = config.autoPilot;
    this.mass = EMPTY_MASS + FULL_LOAD_MASS * LOAD_FRACTION[config.load];
  }

  get rear(): number {
    return this.front - this.direction * TRAIN_LENGTH;
  }

  get length(): number {
    return TRAIN_LENGTH;
  }

  get carCount(): number {
    return CAR_COUNT;
  }

  get occupiedBlockIds(): number[] {
    return this.occupiedBlocks.map((b) => b.id);
  }

  get ebActive(): boolean {
    return this.atp.emergencyActive || this.ebButton || this.ebPenalty;
  }

  applyPenalty(): void {
    if (!this.ebPenalty && Math.abs(this.speed) > STANDSTILL_SPEED) this.ebPenalty = true;
  }

  // ------------------------------------------------------------------ input

  setInput(input: DriverInput): void {
    this.powerNotch = clamp(Math.round(input.power), 0, POWER_NOTCHES);
    this.brakeNotch = clamp(Math.round(input.brake), 0, BRAKE_NOTCHES);
    this.ebButton = input.ebButton;
    if (input.reverser !== this.reverser) {
      // Reverser only moves while stopped.
      if (Math.abs(this.speed) <= STANDSTILL_SPEED) this.reverser = input.reverser;
    }
  }

  trigger(event: TrainEvent): void {
    if (event === 'rollback') {
      if (this.overshoot && !this.failedStop && this.rollbackRemaining === null) {
        this.rollbackRemaining = Math.abs(this.stopError ?? 0);
      }
      return;
    }
    if (event === 'closeDoors') {
      if (this.doorsOpen && this.doorsOpenTimer >= MIN_DOORS_OPEN_TIME) {
        this.doorsOpen = false;
      }
      return;
    }
    if (event === 'confirm' && this.ebPenalty && Math.abs(this.speed) <= STANDSTILL_SPEED) {
      this.ebPenalty = false;
    }
    this.atp.handleEvent(event);
  }

  // -------------------------------------------------------------------- step

  step(dt: number, line: Line, signals: SignalSystem): void {
    // Locate blocks and authority first; occupancy is refreshed by the World
    // before authority computation, so here we only read.
    const frontBlock = blockAt(line, this.trackId, this.front);
    this.occupiedBlocks = this.blocksCovered(line);
    this.ma = signals.authorityFor(this.trackId, frontBlock, this.direction, this.front);

    const station = this.currentStation(line);
    this.updateStationPhase(dt, line, station);

    // During turnback the train is held stationary; supervision and forces
    // resume only after the direction has been reversed.
    if (this.phase === 'turnback') {
      this.speed = 0;
      this.tractionForce = 0;
      this.edForce = 0;
      this.airForce = 0;
      this.lastGrade = gradeAt(line, this.front);
      this.lastCurve = curveAt(line, this.front);
      this.lastLine = line;
      this.lastAtp = this.atp.snapshot(this.ma, line, this.front);
      return;
    }

    this.lastAtp = this.atp.update(dt, {
      line,
      front: this.front,
      speed: this.speed,
      direction: this.direction,
      ma: this.ma,
      autoPilot: this.autoPilot,
      nextStationChainage: this.nextStationStop(line),
    });
    if (this.atp.emergencyActive) this.ebCounter += dt;
    else this.ebCounter = 0;

    this.lastGrade = gradeAt(line, this.front);
    this.lastCurve = curveAt(line, this.front);
    this.lastLine = line;
    this.applyActuators(dt, line);
    this.integrate(dt, line);

    this.occupiedBlocks = this.blocksCovered(line);
  }

  // --------------------------------------------------------------- actuators

  private applyActuators(dt: number, line: Line): void {
    const v = Math.abs(this.speed);
    const grade = gradeAt(line, this.front);

    const tractionInterlock =
      this.doorsOpen || this.ebActive || this.reverser === 0 || this.phase === 'turnback';

    // Traction demand: constant force up to switch speed, then constant power.
    let tractiveTarget = 0;
    if (!tractionInterlock && this.powerNotch > 0) {
      const notchFrac = this.powerNotch / POWER_NOTCHES;
      const switchSpeed = MAX_TRACTIVE_POWER / MAX_TRACTIVE_FORCE; // ~11.3 m/s
      const speedForForce = Math.max(v, 0.5);
      const forceAtSpeed =
        speedForForce < switchSpeed
          ? MAX_TRACTIVE_FORCE
          : MAX_TRACTIVE_POWER / speedForForce;
      tractiveTarget = notchFrac * forceAtSpeed;
    }
    // Traction is cut the moment its opposing brake is requested.
    if (this.brakeNotch > 0 || this.ebActive) tractiveTarget = 0;
    const tractionTau = tractiveTarget > this.tractionForce ? TRACTION_BUILD_TAU : TRACTION_RELEASE_TAU;
    this.tractionForce = lag(this.tractionForce, tractiveTarget, tractionTau, dt);

    // --- Braking ----------------------------------------------------------
    const edAvailable = edAvailability(v);
    let edDemand = 0;
    let airDemand = 0;

    if (this.ebActive) {
      // EB demands a guaranteed deceleration; demand whatever force that takes
      // here, the actuator model blends ED + air around it.
      const neededForce = this.mass * EB_DECEL + gradeResistForce(this.mass, grade);
      const edCap = EB_FORCE * edAvailable;
      edDemand = Math.min(neededForce, edCap);
      airDemand = Math.max(0, neededForce - edDemand);
      airDemand = Math.min(airDemand, AIR_MAX_FORCE * 1.3);
    } else if (this.brakeNotch > 0) {
      // A brake notch requests a fixed fraction of total hardware force: the
      // same notch therefore brakes harder for an empty train (per tonne).
      const requested = (this.brakeNotch / BRAKE_NOTCHES) * BRAKE_TOTAL_FORCE;
      const edCap = ED_MAX_FORCE * edAvailable;
      edDemand = Math.min(requested, edCap);
      airDemand = Math.max(0, requested - edDemand);
      if (v <= STANDSTILL_SPEED) {
        // Electric brake gone at standstill: air brake holds the train.
        edDemand = 0;
        airDemand = requested;
      }
    }

    this.edForce = lag(this.edForce, edDemand, ED_TAU, dt);
    // Air brake builds and releases slowly; demand above zero fills the pipe.
    // Applying traction force-releases the air brake (power/brake interlock).
    const powerReleasing = tractiveTarget > 0;
    const airTau =
      airDemand > this.airForce
        ? AIR_FILL_TAU
        : powerReleasing
          ? AIR_RELEASE_TAU * 0.25
          : AIR_RELEASE_TAU;
    this.airForce = lag(this.airForce, airDemand, airTau, dt);
    // Parking / standstill hold. Once the train is being held at rest it keeps
    // holding until real traction arrives, even if residual jitter crosses the
    // standstill threshold for a tick or two.
    const unpowered = this.powerNotch === 0 && this.tractionForce < 5000;
    if (this.parkingHeld || (v <= STANDSTILL_SPEED && unpowered)) {
      const driverBrake = this.brakeNotch > 0 || this.ebActive;
      const floor = driverBrake ? AIR_MAX_FORCE * 0.6 : AIR_MAX_FORCE * 0.8;
      // Hold against the current grade with a safety margin.
      const gradeHold = Math.abs(gradeResistForce(this.mass, grade)) * 1.5 + 10000;
      this.airForce = Math.max(this.airForce, Math.min(floor, gradeHold));
      this.parkingHeld = unpowered;
    }
    if (!unpowered) this.parkingHeld = false;
  }

  // -------------------------------------------------------------- integration

  private integrate(dt: number, line: Line): void {
    const v = this.speed;
    const absV = Math.abs(v);
    const grade = gradeAt(line, this.front);
    const radius = curveAt(line, this.front);

    // All forces projected onto increasing-chainage axis.
    const traction = this.reverser === 0 ? 0 : this.tractionForce * this.reverser;
    // Brake force always opposes the actual velocity. At a genuine standstill
    // it points against the reverser/grade so the train stays put.
    let brakeSign: number;
    if (absV > STANDSTILL_SPEED) {
      brakeSign = -Math.sign(v);
    } else {
      // Parked: resist whichever way the grade would roll the train; if level,
      // oppose the travel direction.
      brakeSign = Math.abs(grade) > 1e-6 ? -Math.sign(grade) : -this.direction;
    }
    // While pulling away under power, residual brake force is suppressed.
    const suppressBrake = absV <= STANDSTILL_SPEED && this.powerNotch > 0;
    const brake = suppressBrake ? 0 : (this.edForce + this.airForce) * brakeSign;

    const davis = DAVIS_A + DAVIS_B * absV + DAVIS_C * absV * absV;
    const gradeForce = gradeResistForce(this.mass, grade);
    // Chinese railway formula w = 700/R in N per kN of train weight:
    // specific resistance (N/kN) -> divide by 1000 to get a force fraction.
    const curveSpecific = Number.isFinite(radius)
      ? CURVE_RESIST_COEFF / Math.abs(radius) / 1000
      : 0;
    // Smoothly ramp running resistance to zero below the standstill threshold
    // so the force field is continuous through v=0. Grade resistance keeps its
    // fixed physical sign (uphill is always uphill).
    const motionFactor = Math.min(1, absV / STANDSTILL_SPEED);
    const runningResist = (davis + this.mass * G * curveSpecific) * motionFactor;
    const resistSign = absV > STANDSTILL_SPEED ? Math.sign(v) : this.direction;
    const resistance = -runningResist * resistSign - gradeForce;

    const totalForce = traction + brake + resistance;
    this.acceleration = totalForce / (this.mass * ROTATIONAL_FACTOR);

    let nextSpeed = v + this.acceleration * dt;

    // Emergency brake: once the train is effectively at rest, pin it to zero
    // so the EB stopped-hold timer can accumulate instead of oscillating at
    // the standstill threshold forever. Traction is physically cut during EB
    // regardless of the power notch, so the notch position is irrelevant here.
    if (this.ebActive && absV <= 0.6) {
      nextSpeed = 0;
    }

    // Parking hold: an unpowered train held at rest is physically stationary.
    // Clamp directly so grade jitter cannot produce a steady creep velocity.
    if (this.parkingHeld && this.powerNotch === 0 && absV <= 1.0) {
      nextSpeed = 0;
    }

    // Non-slip stop: a brake-holding, unpowered train clamps at zero instead
    // of rolling back. Power application always allows the train to pull away.
    const holding =
      absV <= STANDSTILL_SPEED &&
      (this.brakeNotch > 0 || this.ebActive) &&
      this.powerNotch === 0;
    if (holding && Math.sign(nextSpeed) !== Math.sign(v) && Math.abs(nextSpeed) < 1.0) {
      nextSpeed = 0;
    }
    this.speed = nextSpeed;
    let ds = this.speed * dt;
    // Hard physical buffer at the line ends: stop the train instead of
    // accumulating speed against a clamped position.
    const minFront = 5;
    const maxFront = line.length - 5;
    if (this.front + ds < minFront) {
      ds = minFront - this.front;
      this.front = minFront;
      if (this.speed < 0) this.speed = 0;
    } else if (this.front + ds > maxFront) {
      ds = maxFront - this.front;
      this.front = maxFront;
      if (this.speed > 0) this.speed = 0;
    } else {
      this.front += ds;
    }
    this.distanceTravelled += Math.abs(ds);
  }

  // ------------------------------------------------------------- station FSM

  private currentStation(line: Line) {
    let best: { id: number; chainage: number } | null = null;
    let bestDist = Infinity;
    for (const s of line.stations) {
      const d = Math.abs(s.chainage - this.front);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    // Only treat it as "at a station" within a couple of train lengths.
    return bestDist < TRAIN_LENGTH ? best : null;
  }

  /** Chainage the automatic train is aiming to stop at, if close enough. */
  private nextStationStop(line: Line): number | null {
    if (this.phase !== 'running') return null;
    for (const s of line.stations) {
      const sAhead = (s.chainage - this.front) * this.direction;
      if (sAhead > -2 && sAhead < 600) return s.chainage;
    }
    return null;
  }

  private updateStationPhase(dt: number, line: Line, station: { id: number; chainage: number } | null): void {
    if (this.phase === 'turnback') {
      // Hold the train still during the turnback, then reverse.
      this.speed = 0;
      this.turnbackTimer -= dt;
      if (this.turnbackTimer <= 0) {
        this.direction = (this.direction * -1) as Direction;
        this.reverser = this.direction;
        this.phase = 'running';
        this.currentStationId = null;
      }
      return;
    }

    if (this.phase === 'dwell') {
      this.doorsOpenTimer += dt;
      this.dwellRemaining = Math.max(0, this.dwellRemaining - dt);
      if (this.autoPilot && this.dwellRemaining <= 0 && !this.doorsOpen) {
        this.endDwell(line, station);
      }
      return;
    }

    // Running: a stop only counts when the train has been held under the
    // standstill threshold for a confirmation period (creeping doesn't count).
    if (Math.abs(this.speed) <= STANDSTILL_SPEED) this.stoppedTimer += dt;
    else this.stoppedTimer = 0;
    if (!station || this.stoppedTimer < STOP_CONFIRM_TIME) return;
    // Signed error along the travel direction: + short of mark, - past it.
    const error = (station.chainage - this.front) * this.direction;
    if (Math.abs(error) > TRAIN_LENGTH) return;

    this.currentStationId = station.id;
    this.stopError = error;
    if (Math.abs(error) <= 0.3) {
      this.overshoot = false;
      this.failedStop = false;
      this.openDwell(dt);
    } else if (error < 0) {
      // Stopped past the mark.
      this.overshoot = true;
      if (Math.abs(error) > ROLLBACK_MAX_DISTANCE) {
        this.failedStop = true;
        this.openDwell(dt); // doors stay closed; dwell just marks the failed stop
      }
      // Within rollback range: wait for the regulated reversing manoeuvre.
    } else {
      // Stopped short of the mark: allow a careful re-approach.
      this.stopError = error;
    }
  }

  private openDwell(dt: number): void {
    this.phase = 'dwell';
    if (!this.failedStop) {
      this.doorsOpen = true;
      this.doorsOpenTimer = dt;
      this.dwellRemaining = DWELL_TIME;
    } else {
      this.doorsOpen = false;
      this.dwellRemaining = DWELL_TIME;
    }
  }

  private endDwell(line: Line, station: { id: number; chainage: number } | null): void {
    this.phase = 'running';
    this.doorsOpen = false;
    this.stopError = null;
    this.currentStationId = null;
    const isTerminal =
      station !== null && (station.id === 0 || station.id === line.stations.length - 1);
    if (isTerminal && this.autoPilot) {
      this.phase = 'turnback';
      this.turnbackTimer = TURNBACK_TIME;
    }
  }

  /** Called by the World after the player presses close doors and dwell elapses. */
  tryResume(line: Line): void {
    if (this.phase === 'dwell' && !this.doorsOpen && this.dwellRemaining <= 0) {
      const station = this.currentStation(line);
      this.endDwell(line, station);
    }
  }

  /** Advance the rollback manoeuvre timer; called by the World every tick while active. */
  continueRollback(dt: number): void {
    if (this.rollbackRemaining === null) return;
    this.rollbackRemaining = Math.max(0, this.rollbackRemaining - Math.abs(this.speed) * dt);
    if (this.rollbackRemaining <= 0 && Math.abs(this.speed) <= STANDSTILL_SPEED) {
      this.rollbackRemaining = null;
      this.overshoot = false;
      this.stopError = 0;
      // Restore the forward reverser before opening the doors.
      this.reverser = this.direction;
      this.speed = 0;
      this.parkingHeld = true;
      this.openDwell(dt);
    }
  }

  // ---------------------------------------------------------------- occupancy

  private blocksCovered(line: Line): BlockDef[] {
    const result: BlockDef[] = [];
    const seen = new Set<number>();
    const samples = [this.front, this.rear, (this.front + this.rear) / 2];
    for (const chainage of samples) {
      const b = blockAt(line, this.trackId, chainage);
      if (b && !seen.has(b.id)) {
        seen.add(b.id);
        result.push(b);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- snapshot

  snapshot(): TrainSnapshot {
    return {
      id: this.id,
      label: this.label,
      trackId: this.trackId,
      front: this.front,
      rear: this.rear,
      speed: this.speed,
      acceleration: this.acceleration,
      direction: this.direction,
      reverser: this.reverser,
      phase: this.phase,
      doorsOpen: this.doorsOpen,
      load: this.load,
      mass: this.mass,
      autoPilot: this.autoPilot,
      occupiedBlockIds: this.occupiedBlockIds,
      atp: this.lastLine
        ? this.atp.snapshot(this.ma, this.lastLine, this.front)
        : (this.lastAtp as AtpSnapshot),
      tractionForceN: this.tractionForce,
      edForceN: this.edForce,
      airForceN: this.airForce,
      grade: this.lastGrade,
      curveRadius: this.lastCurve,
      currentStationId: this.currentStationId,
      stopError: this.stopError,
      doorsOpenTimer: this.doorsOpenTimer,
      dwellRemaining: this.dwellRemaining,
      overshoot: this.overshoot,
      failedStop: this.failedStop,
      rollbackRemaining: this.rollbackRemaining,
      ebCounter: this.ebCounter,
      distanceTravelled: this.distanceTravelled,
    };
  }
}

function gradeResistForce(mass: number, grade: number): number {
  return mass * G * grade;
}

function edAvailability(v: number): number {
  if (v >= ED_FULL_SPEED) return 1;
  if (v <= ED_FADEOUT_SPEED) return 0;
  return (v - ED_FADEOUT_SPEED) / (ED_FULL_SPEED - ED_FADEOUT_SPEED);
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}
