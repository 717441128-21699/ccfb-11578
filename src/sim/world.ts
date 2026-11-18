import { CONFIG, massFor, type LoadState, type TrainInput, type TrainRuntime } from './config';
import { buildLine, blockAt, nextStation, type Line } from './line';
import { SignalSystem } from './signal';
import { canReleaseEmergency, evaluateAtp, supervisedSpeed } from './atp';
import { updateForces, integrateMotion } from './dynamics';
import { updateStationStop } from './station';
import { AiDriver } from './driver';

export interface WorldSnapshot {
  tick: number;
  time: number;
  trains: TrainRuntime[];
  line: Line;
  signals: SignalSystem;
  player: TrainRuntime;
}

let trainSeq = 0;

function makeTrain(s: number, isPlayer: boolean, load: LoadState): TrainRuntime {
  const id = trainSeq++;
  return {
    id,
    name: isPlayer ? '本务列车' : `CBTC-${String(id + 1).padStart(2, '0')}`,
    isPlayer,
    load,
    s,
    v: 0,
    tractionForce: 0,
    edBrakeForce: 0,
    airBrakeForce: 0,
    emergencyForce: 0,
    emergencyApplied: false,
    ebAck: false,
    input: {
      tractionNotch: 0,
      brakeNotch: 0,
      emergencyBrake: false,
      reverseMode: false,
      doorsOpen: false,
    },
    atpAlarm: false,
    atpEmergency: false,
    supervisedSpeed: 0,
    authorityEnd: s + 600,
    authorityDistance: 600,
    nextSignalAspect: 'GREEN',
    nextStationIndex: 0,
    doorsOpen: false,
    dwellRemaining: 0,
    dwellComplete: false,
    stopError: null,
    stopStatus: 'none',
    reversePermitted: false,
    psdOpen: false,
    grade: 0,
    curveRadius: null,
    totalResistance: 0,
    mass: massFor(load),
  };
}

export class World {
  readonly line: Line;
  readonly signals: SignalSystem;
  readonly trains: TrainRuntime[];
  readonly player: TrainRuntime;
  private ai: AiDriver[] = [];
  tick = 0;
  time = 0;
  readonly dt = CONFIG.sim.dt;

  constructor() {
    this.line = buildLine();
    this.signals = new SignalSystem(this.line);

    // 12 列车沿环线均匀布置，初始都在分区边界附近、互相间隔若干分区
    const n = CONFIG.line.trainCount;
    const spacing = this.line.length / n;
    this.trains = [];
    for (let i = 0; i < n; i++) {
      const s = (i * spacing) % this.line.length;
      const isPlayer = i === 0;
      const tr = makeTrain(s, isPlayer, 'AW3');
      tr.nextStationIndex = nextStation(this.line, s).station.index;
      tr.authorityEnd = nextStation(this.line, s).station.stopS;
      this.trains.push(tr);
      if (!isPlayer) this.ai.push(new AiDriver());
    }
    this.player = this.trains[0];
  }

  /** 玩家输入由 UI 直接写入 player.input；AI 车每步由系统覆写 */
  setPlayerInput(patch: Partial<TrainInput>): void {
    Object.assign(this.player.input, patch);
  }

  togglePlayerLoad(): LoadState {
    if (Math.abs(this.player.v) > CONFIG.station.stopDetectSpeed) return this.player.load;
    this.player.load = this.player.load === 'AW3' ? 'AW0' : 'AW3';
    this.player.mass = massFor(this.player.load);
    return this.player.load;
  }

  /** 紧急制动停稳后的缓解确认 */
  acknowledgeEmergency(): boolean {
    this.player.ebAck = true;
    return true;
  }

  /** 测试场景：命令前车（id=1）在区间紧急停车，验证后车 ATP 拦截 */
  triggerObstacleTest(): void {
    const target = this.trains[1];
    if (target) {
      target.emergencyApplied = true;
      target.input.emergencyBrake = true;
      target.input.tractionNotch = 0;
    }
  }

  step(): void {
    const dt = this.dt;

    // 1) 占用检测
    this.signals.updateOccupancy(this.trains);

    // 2) 每车移动授权 + 信号显示
    for (const tr of this.trains) {
      const auth = this.signals.authorityFor(tr);
      tr.authorityEnd = auth.endS;
      tr.authorityDistance = auth.distance;
      tr.nextSignalAspect = this.signals.aspectAhead(tr);
      tr.nextStationIndex = nextStation(this.line, tr.s).station.index;

      // 3) ATP 监督
      const verdict = evaluateAtp(this.line, tr, auth);
      tr.supervisedSpeed = verdict.supervised;
      tr.atpAlarm = verdict.alarm;
      if (verdict.triggerEB) {
        tr.emergencyApplied = true;
        tr.atpEmergency = true;
        tr.input.emergencyBrake = true;
        tr.input.tractionNotch = 0;
      }

      // 4) 紧急制动缓解
      if (tr.emergencyApplied) {
        if (canReleaseEmergency(this.line, tr, auth)) {
          tr.emergencyApplied = false;
          tr.atpEmergency = false;
          tr.ebAck = false;
          tr.input.emergencyBrake = false;
        }
      }
    }

    // 5) AI 司机决策（在 ATP 之后、力学之前）
    let aiIdx = 0;
    for (const tr of this.trains) {
      if (tr.isPlayer) continue;
      const driver = this.ai[aiIdx++];
      const supervised = supervisedSpeed(this.line, tr, this.signals.authorityFor(tr));
      const decision = driver.decide(this.line, tr, supervised);
      // AI 不能越过 ATP 锁存
      if (tr.emergencyApplied) {
        decision.tractionNotch = 0;
        decision.brakeNotch = 0;
        tr.ebAck = true; // AI 停稳后自动确认
      }
      tr.input = decision;
    }

    // 6) 力学
    for (const tr of this.trains) {
      const forces = updateForces(tr, this.line, dt);
      integrateMotion(tr, forces, this.line, dt);
    }

    // 7) 站台对标 / 车门 / 屏蔽门
    for (const tr of this.trains) {
      updateStationStop(this.line, tr, dt);
      // 诊断字段
      void blockAt(this.line, tr.s);
    }

    this.tick++;
    this.time += dt;
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      time: this.time,
      trains: this.trains,
      line: this.line,
      signals: this.signals,
      player: this.player,
    };
  }
}
