import { CONFIG, type TrainRuntime } from './config';
import { clamp, approachFirstOrder } from './mathutil';
import { gradeAt, curveAt, type Line } from './line';

const T = CONFIG.train;

/** 当前速度下手柄 100% 可发出的最大牵引力（恒力 + 恒功率衰减段） */
export function maxTractionAtSpeed(v: number): number {
  const speed = Math.abs(v);
  if (speed <= T.tractionKneeSpeed) return T.maxTractionForce;
  // 恒功率：F = F_knee * v_knee / v
  return (T.maxTractionForce * T.tractionKneeSpeed) / speed;
}

/** 电制动可用比例：50km/h 以上全力，1.5m/s 以下退出 */
export function edBrakeAvailability(v: number): number {
  const speed = Math.abs(v);
  if (speed >= T.edBrakeKneeSpeed) return 1;
  if (speed <= T.edBrakeFadeSpeed) return 0;
  return (speed - T.edBrakeFadeSpeed) / (T.edBrakeKneeSpeed - T.edBrakeFadeSpeed);
}

/**
 * Davis 基本阻力（N）。参数为每吨阻力，按实际质量折算。
 * R = (a + b v + c v^2) * (mass / 1000)
 */
export function davisResistance(mass: number, v: number): number {
  const speed = Math.abs(v);
  const perTonne = T.davisA + T.davisB * speed + T.davisC * speed * speed;
  return perTonne * (mass / 1000);
}

/** 坡道阻力 N：坡度 ‰ -> sin(atan(grade/1000)) ≈ grade/1000 */
export function gradientResistance(mass: number, gradePermille: number): number {
  return mass * 9.81 * (gradePermille / 1000);
}

/** 曲线阻力 N（经验公式 700/R，单位 N/kN 车重折算） */
export function curveResistance(mass: number, radius: number | null): number {
  if (radius === null) return 0;
  return mass * 9.81 * (700 / radius) / 1000;
}

export interface ForceBreakdown {
  traction: number;
  edBrake: number;
  airBrake: number;
  emergency: number;
  grade: number;
  curve: number;
  davis: number;
  total: number;
}

/**
 * 根据手柄指令与当前状态，更新各力的实际值（含建立/缓解迟滞），
 * 并返回合力。制动力方向与运动方向相反；静止时按指令方向预备。
 */
export function updateForces(train: TrainRuntime, line: Line, dt: number): ForceBreakdown {
  const speed = Math.abs(train.v);
  const moving = speed > 0.02;
  const input = train.input;

  // ---------- 牵引力 ----------
  const tractionBlocked =
    input.doorsOpen || train.emergencyApplied || (input.brakeNotch > 0.01 && moving);
  const tractionTarget = tractionBlocked ? 0 : maxTractionAtSpeed(train.v) * input.tractionNotch;
  train.tractionForce = approachFirstOrder(train.tractionForce, tractionTarget, T.tractionLag, dt);

  // ---------- 常用制动需求 ----------
  const serviceDemand = input.brakeNotch; // 0..1
  const wantedBrake = serviceDemand * (T.maxEdBrakeForce + T.maxAirBrakeForce);

  // 电制动承担部分（受低速退出限制）
  const edTarget = moving
    ? Math.min(wantedBrake, T.maxEdBrakeForce) * edBrakeAvailability(train.v)
    : 0;
  train.edBrakeForce = approachFirstOrder(train.edBrakeForce, edTarget, T.edBrakeLag, dt);

  // 电制动不够的部分由空气制动补足（空气制动建立/缓解都慢）
  const airTarget = moving ? Math.max(0, wantedBrake - train.edBrakeForce) : wantedBrake;
  const airTau = airTarget > train.airBrakeForce ? T.brakeBuildLag : T.brakeReleaseLag;
  train.airBrakeForce = approachFirstOrder(train.airBrakeForce, airTarget, airTau, dt);

  // ---------- 紧急制动（独立纯空气回路，锁存，直到停稳确认缓解） ----------
  const ebTarget = train.emergencyApplied ? T.emergencyBrakeForce : 0;
  const ebTau = ebTarget > train.emergencyForce ? T.emergencyBuildLag : T.brakeReleaseLag;
  train.emergencyForce = approachFirstOrder(train.emergencyForce, ebTarget, ebTau, dt);

  // ---------- 阻力 ----------
  const grade = gradeAt(line, train.s);
  const radius = curveAt(line, train.s);
  train.grade = grade;
  train.curveRadius = radius;

  const fDavis = moving ? davisResistance(train.mass, train.v) : 0;
  const fGrade = gradientResistance(train.mass, grade);
  const fCurve = curveResistance(train.mass, radius);

  // 静止/低速防溜制动：无牵引指令时，在 0.5m/s 以下连续施加保持力，
  // 抵消坡道重力分力（真实车辆的停放/保持制动逻辑）。
  // 关键：不能只在完全静止时施加，否则一旦轻微溜车保持力就消失，越溜越快。
  let holdForce = 0;
  const wantsHold = input.tractionNotch < 0.02 && !train.emergencyApplied;
  if (wantsHold && Math.abs(train.v) < 0.5) {
    const gradeThrust = Math.abs(fGrade) + Math.abs(fCurve);
    holdForce = Math.min(T.rollbackHoldForce, gradeThrust + 30_000);
  }

  // 制动力方向：与速度反向；静止时由防溜逻辑保持
  const brakeDir = moving ? -Math.sign(train.v) : 0;
  const brakeMag = train.emergencyApplied
    ? train.emergencyForce
    : train.edBrakeForce + train.airBrakeForce + holdForce;
  const fBrake = brakeDir * brakeMag;

  const total = train.tractionForce + fBrake - fDavis - fGrade - fCurve;

  return {
    traction: train.tractionForce,
    edBrake: train.emergencyApplied ? 0 : train.edBrakeForce,
    airBrake: train.emergencyApplied ? 0 : train.airBrakeForce,
    emergency: train.emergencyForce,
    grade: fGrade,
    curve: fCurve,
    davis: fDavis,
    total,
  };
}

/**
 * 平准化积分：合力 -> 加速度 -> 速度 -> 里程。
 * 含静止防溜、退行限速与牵引封锁。
 */
export function integrateMotion(train: TrainRuntime, forces: ForceBreakdown, line: Line, dt: number): void {
  const input = train.input;

  // 停站开门 / 紧急制动未缓解时牵引封锁
  const tractionInterlock = input.doorsOpen || train.emergencyApplied;
  const effectiveTotal = tractionInterlock && forces.total > 0
    ? forces.total - forces.traction
    : forces.total;

  const accel = effectiveTotal / train.mass;
  let vNew = train.v + accel * dt;

  if (input.reverseMode) {
    // 合规退行：限速 10km/h
    vNew = Math.max(vNew, -T.reverseSpeedLimit);
  } else if (vNew < 0) {
    // 非退行模式：保持制动在速度过零处硬钳位，禁止任何溜车
    vNew = 0;
  }

  // 静止防溜：速度极小且有制动/保持力时锁零
  if (Math.abs(vNew) <= 0.05 && hasHoldForce(train)) {
    vNew = 0;
  }

  train.v = vNew;
  train.s = (train.s + train.v * dt + line.length) % line.length;
  train.totalResistance = forces.davis + forces.grade + forces.curve;
}

function hasHoldForce(train: TrainRuntime): boolean {
  return (
    train.emergencyApplied ||
    train.emergencyForce > 5000 ||
    train.input.brakeNotch > 0.05 ||
    train.input.doorsOpen ||
    train.airBrakeForce > 5000
  );
}

/** 停车标窗口判定用：手柄归一化工具 */
export function notchPercent(x: number): number {
  return Math.round(clamp(x, 0, 1) * 100);
}
