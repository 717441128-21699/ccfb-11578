import { CONFIG, type TrainRuntime } from './config';
import { clamp } from './mathutil';
import { nextSpeedReduction, nextStation, speedLimitAt, type Line } from './line';
import type { Authority } from './signal';

const A = CONFIG.atp;

export interface BrakingTarget {
  /** 距当前车头的距离 m */
  distance: number;
  /** 目标点允许速度 m/s（停车目标为 0） */
  targetSpeed: number;
  kind: 'authority' | 'station' | 'speedlimit';
}

/**
 * 收集前方所有制动约束目标：
 * 1) 移动授权终点（v=0），扣减安全防护距离以覆盖制动建立迟滞
 * 2) 线路限速下降点
 * 3) 接近窗口内的站台停车标（v=0）
 */
export function collectTargets(line: Line, train: TrainRuntime, auth: Authority): BrakingTarget[] {
  const targets: BrakingTarget[] = [];

  targets.push({
    distance: Math.max(0, auth.distance - A.safetyDistance),
    targetSpeed: 0,
    kind: 'authority',
  });

  const currentLimit = speedLimitAt(line, train.s);
  const reduction = nextSpeedReduction(line, train.s, currentLimit);
  if (reduction && reduction.distance < A.targetLookahead) {
    targets.push({
      distance: Math.max(0, reduction.distance - A.safetyDistance * 0.4),
      targetSpeed: reduction.speed,
      kind: 'speedlimit',
    });
  }

  const ns = nextStation(line, train.s);
  if (ns.distance < A.stationApproachWindow && !train.doorsOpen) {
    targets.push({ distance: Math.max(0, ns.distance), targetSpeed: 0, kind: 'station' });
  }

  return targets;
}

/**
 * 单点制动曲线：在距离 d 处要降到 v_target，当前允许的最大速度。
 * v_perm(d) = sqrt(v_target^2 + 2 * a_guaranteed * d)
 */
export function permittedSpeedAt(target: BrakingTarget, distanceFromTrain: number): number {
  const dToTarget = Math.max(0, target.distance - distanceFromTrain);
  return Math.sqrt(target.targetSpeed ** 2 + 2 * A.guaranteedDecel * dToTarget);
}

/**
 * 当前位置的 ATP 监督速度 = 所有约束曲线在 d=0 处的最小值，
 * 再与当前位置静态限速取小。
 */
export function supervisedSpeed(line: Line, train: TrainRuntime, auth: Authority): number {
  const targets = collectTargets(line, train, auth);
  let v = speedLimitAt(line, train.s);
  for (const t of targets) {
    v = Math.min(v, permittedSpeedAt(t, 0));
  }
  return v;
}

/**
 * 沿前方里程采样整条制动曲线（HUD 速度表/渲染用）。
 * 返回 [{d, v}]，d 为距车头距离。
 */
export function sampleCurve(
  line: Line,
  train: TrainRuntime,
  auth: Authority,
  maxDistance = 900,
  step = 15,
): { d: number; v: number }[] {
  const targets = collectTargets(line, train, auth);
  const out: { d: number; v: number }[] = [];
  for (let d = 0; d <= maxDistance; d += step) {
    let v = speedLimitAt(line, (train.s + d) % line.length);
    for (const t of targets) {
      if (d <= t.distance) v = Math.min(v, permittedSpeedAt(t, d));
    }
    out.push({ d, v });
  }
  return out;
}

export interface AtpVerdict {
  supervised: number;
  alarm: boolean;
  triggerEB: boolean;
}

/**
 * ATP 监督判定：
 * - v > v_supervised + 报警余量 -> 声光报警
 * - v > v_supervised + EB 余量 -> 触发紧急制动（锁存）
 * 报警后若司机减速回到曲线内，报警自动消除；EB 一经触发必须停稳确认。
 */
export function evaluateAtp(line: Line, train: TrainRuntime, auth: Authority): AtpVerdict {
  const supervised = supervisedSpeed(line, train, auth);
  const speed = Math.abs(train.v);

  const alarm = speed > supervised + A.alarmMargin;
  const triggerEB =
    !train.emergencyApplied && speed > supervised + A.ebMargin;

  return { supervised, alarm, triggerEB };
}

/**
 * 紧急制动缓解条件：
 * 1) 列车已停稳（|v| < 判停速度）
 * 2) 司机/系统执行确认（ebAck）
 * 3) 当前速度已回到监督曲线内（防止确认后立刻再触发）
 * 全部满足才允许缓解。
 */
export function canReleaseEmergency(line: Line, train: TrainRuntime, auth: Authority): boolean {
  if (!train.emergencyApplied) return false;
  const stopped = Math.abs(train.v) < CONFIG.station.stopDetectSpeed;
  const backUnderCurve =
    Math.abs(train.v) <= supervisedSpeed(line, train, auth) + A.alarmMargin;
  return stopped && train.ebAck && backUnderCurve;
}

/** 给 UI/AI 用的建议速度（用于 AI 司机跟曲线） */
export function advisorySpeed(supervised: number): number {
  return clamp(supervised - 3.0 / 3.6, 0, CONFIG.train.maxSpeed);
}
