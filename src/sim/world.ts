import { AiDriver } from './aiDriver';
import {
  FLEET_SPACING_STATIONS,
  ROLLBACK_SPEED,
  SIM_DT,
  STATION_COUNT,
  TRAIN_LENGTH,
  TRAINS_PER_TRACK,
} from './constants';
import { generateLine, type Line } from './line';
import { SignalSystem } from './signaling';
import { Train, type LoadLevel, type TrainSnapshot } from './train';
import type { DriverInput, TrainEvent, TrackId } from './types';

export interface WorldSnapshot {
  time: number;
  tick: number;
  trains: TrainSnapshot[];
  playerId: number;
  lineLength: number;
  stationCount: number;
}

export class World {
  readonly line: Line;
  readonly signals: SignalSystem;
  readonly trains: Train[] = [];
  readonly playerId = 0;
  private readonly ai = new AiDriver();
  private time = 0;
  private tickCount = 0;

  constructor(seed?: number) {
    this.line = generateLine(seed);
    this.signals = new SignalSystem(this.line);
    this.spawnFleet();
    // Initial occupancy so authorities are valid on the very first tick.
    this.refreshOccupancy();
    for (const train of this.trains) train.initialize(this.line, this.signals);
    this.signals.refreshAspects();
  }

  get timeSeconds(): number {
    return this.time;
  }

  get player(): Train {
    return this.trains[this.playerId];
  }

  private spawnFleet(): void {
    const loads: LoadLevel[] = ['empty', 'half', 'full'];
    let id = 0;
    for (const trackId of [0, 1] as TrackId[]) {
      const direction = trackId === 0 ? 1 : -1;
      for (let k = 0; k < TRAINS_PER_TRACK; k++) {
        const stationIdx = (k * FLEET_SPACING_STATIONS) % STATION_COUNT;
        const station = this.line.stations[stationIdx];
        // Front at the stopping mark, offset toward the approach side.
        const front = station.chainage - direction * TRAIN_LENGTH * 0.5;
        const isPlayer = trackId === 0 && k === 0;
        const train = new Train({
          id: id++,
          label: `G${String(id).padStart(2, '0')}`,
          trackId,
          direction,
          front,
          load: loads[k % loads.length],
          autoPilot: !isPlayer,
        });
        this.trains.push(train);
      }
    }
  }

  /** Advance the whole simulation one fixed step (10 ms -> 100 Hz). */
  step(): void {
    const dt = SIM_DT;
    this.time += dt;
    this.tickCount++;

    // 1. Driver intent (AI computes from last tick's signal/ATP state).
    for (const train of this.trains) {
      if (!train.autoPilot) continue;
      const { input, events } = this.ai.drive(train, this.line, this.signals);
      train.setInput(input);
      for (const e of events) train.trigger(e);
    }

    // 2. Refresh block occupancy from current positions.
    this.refreshOccupancy();

    // 3. Authorities, ATP, actuators and integration, train by train.
    for (const train of this.trains) {
      if (train.rollbackRemaining !== null && Math.abs(train.speed) > ROLLBACK_SPEED) {
        // Reversing faster than 5 km/h is a regulated-speed violation.
        train.applyPenalty();
      }
      train.step(dt, this.line, this.signals);
      if (train.rollbackRemaining !== null) {
        train.continueRollback(dt);
      }
    }

    // 4. Signal aspects follow the new occupancy.
    this.signals.refreshAspects();
  }

  private refreshOccupancy(): void {
    this.signals.clear();
    for (const train of this.trains) {
      this.signals.markOccupied(train.trackId, train.occupiedBlockIds);
    }
  }

  // ------------------------------------------------------------- player API

  setPlayerInput(input: DriverInput): void {
    this.player.setInput(input);
  }

  playerEvent(event: TrainEvent): void {
    this.player.trigger(event);
  }

  getSnapshot(): WorldSnapshot {
    return {
      time: this.time,
      tick: this.tickCount,
      trains: this.trains.map((t) => t.snapshot()),
      playerId: this.playerId,
      lineLength: this.line.length,
      stationCount: this.line.stations.length,
    };
  }

  runFor(seconds: number): WorldSnapshot {
    const steps = Math.round(seconds / SIM_DT);
    for (let i = 0; i < steps; i++) this.step();
    return this.getSnapshot();
  }
}
