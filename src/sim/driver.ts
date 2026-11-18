import { CONFIG, type TrainInput, type TrainRuntime } from './config';
import { clamp } from './mathutil';
import { advisorySpeed } from './atp';
import { signedStopError } from './station';
import { nextStation, type Line } from './line';

/**
 * 自动列车司机（简化 ATO）：
 * - 按 ATP 监督速度打折扣作为目标速度
 * - 接近停车标时切换到精确停车控制（目标减速度曲线）
 * - 停站开关门、overshoot 退行全自动
 */
export class AiDriver {
  private brakeIntegral = 0;

  decide(line: Line, train: TrainRuntime, supervised: number): TrainInput {
    const input: TrainInput = { ...train.input };
    const stopped = Math.abs(train.v) < CONFIG.station.stopDetectSpeed;
    const ns = nextStation(line, train.s);
    const stopErr = signedStopError(line, ns.station, train.s);
    // 进站接近：前向站在窗口内，且尚未越过该站停车标
    const approaching =
      ns.distance < CONFIG.atp.stationApproachWindow && stopErr <= 0;

    // 停站流程交给 station 状态机；开门时保持制动、零牵引
    if (train.doorsOpen) {
      input.tractionNotch = 0;
      input.brakeNotch = 0.35;
      input.reverseMode = false;
      return input;
    }

    // overshoot 退行：停稳起步给牵引，移动中限速保持
    if (train.stopStatus === 'overshoot') {
      input.reverseMode = true;
      input.brakeNotch = 0;
      input.tractionNotch = Math.abs(train.v) > 2.0 ? 0 : 0.35;
      return input;
    }
    // short（早停）：前进微调回到停车标。
    // 必须服从 ATP：监督速度趋零（本站停车目标仍生效）时禁止牵引，改用制动。
    if (train.stopStatus === 'short') {
      input.reverseMode = false;
      const dToMark = -stopErr; // 正值=距停车标还有多远
      const curSpeed = Math.abs(train.v);
      // 静止时先起步（只要还没到标），ATP 在运动后再接管制动
      if (stopped && dToMark > 0.05) {
        input.tractionNotch = 0.3;
        input.brakeNotch = 0;
      } else if (!stopped && supervised < curSpeed + 0.8) {
        // 运动中 ATP 要求减速：制动优先，先把速度压到曲线内
        input.tractionNotch = 0;
        input.brakeNotch = clamp(0.4 + (curSpeed - supervised) * 0.4, 0.4, 0.9);
      } else if (dToMark > 2.5) {
        input.tractionNotch = 0.3;
        input.brakeNotch = 0;
      } else {
        // 接近停车标：收牵引，柔和制动
        input.tractionNotch = 0;
        input.brakeNotch = 0.4;
      }
      return input;
    }
    // 停站结束等待发车 / 无任何停站约束的静止车：牵引出站
    if (stopped && !train.doorsOpen && train.stopStatus === 'none') {
      input.reverseMode = false;
      input.tractionNotch = 0.5;
      input.brakeNotch = 0;
      return input;
    }
    if (train.input.reverseMode && train.stopStatus === 'aligned') {
      input.reverseMode = false;
      input.tractionNotch = 0;
    }

    let targetSpeed: number;
    if (approaching) {
      // 停车曲线：希望在停车标处速度为 0，d = 剩余距离
      const d = Math.max(0, -stopErr);
      const ideal = Math.sqrt(2 * 0.75 * d); // 0.75 m/s² 舒适制动
      targetSpeed = Math.min(ideal, supervised - 1.0 / 3.6);
    } else {
      targetSpeed = advisorySpeed(supervised);
    }

    // 追踪防护：按舒适减速度 0.6 m/s² 反推当前允许速度，
    // 让 AI 早于 ATP 硬曲线制动，避免追近后被紧急制动。
    const trackingLimit = Math.sqrt(2 * 0.6 * Math.max(0, train.authorityDistance - 90));
    targetSpeed = Math.min(targetSpeed, trackingLimit, CONFIG.train.maxSpeed);
    targetSpeed = Math.max(0, targetSpeed);

    const speed = Math.abs(train.v);

    // 精确停车直控模式：距停车标 120m 内，按运动学反推所需减速度，
    // 再折算成制动手柄，保证制动缸建立迟滞下仍能按曲线停住。
    const distToStop = -stopErr;
    if (approaching && distToStop < 120 && distToStop > 0.3) {
      const requiredDecel = (speed * speed) / (2 * distToStop); // m/s²
      // 全载荷下手柄 100% 可用减速度约 1.3 m/s²，加 10% 余量克服迟滞
      const notch = clamp((requiredDecel / 1.3) * 1.1, 0.1, 1);
      input.tractionNotch = 0;
      input.brakeNotch = notch;
      this.brakeIntegral = 0;
      return input;
    }
    // 极近停车标：保持制动到停稳
    if (approaching && distToStop <= 0.3) {
      input.tractionNotch = 0;
      input.brakeNotch = Math.max(input.brakeNotch, 0.4);
      return input;
    }

    const err = targetSpeed - speed;

    if (err > 0.4) {
      // 需要加速
      input.brakeNotch = 0;
      const notch = clamp(0.25 + err * 0.12, 0, 1);
      input.tractionNotch = approaching ? Math.min(notch, 0.5) : notch;
      this.brakeIntegral = 0;
    } else if (err < -0.3) {
      // 需要制动：误差越大制动越深
      input.tractionNotch = 0;
      this.brakeIntegral += -err * 0.002;
      const notch = clamp(0.2 + -err * 0.18 + this.brakeIntegral, 0.08, 1);
      input.brakeNotch = notch;
    } else {
      input.tractionNotch = 0;
      input.brakeNotch = 0;
      this.brakeIntegral = 0;
    }

    // 临近停车标且速度极低：施加足够制动保证按曲线停住
    if (approaching && speed < 1.2 && -stopErr < 6) {
      input.tractionNotch = 0;
      input.brakeNotch = Math.max(input.brakeNotch, 0.35);
    }

    // 低速强接管：监督速度进入 6m/s 以下（进站末段/授权终点逼近）时，
    // 只要实际速度高于监督速度就施加与超速量成比例的制动，
    // 避免空气制动建立迟滞导致低速冲出 ATP 曲线触发紧急制动。
    if (supervised < 6.0 && speed > supervised + 0.3 / 3.6) {
      input.tractionNotch = 0;
      const excess = speed - supervised;
      input.brakeNotch = Math.max(input.brakeNotch, clamp(0.4 + excess * 0.5, 0.4, 0.95));
    }

    return input;
  }
}
