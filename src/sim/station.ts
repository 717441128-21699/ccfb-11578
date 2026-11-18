import { CONFIG, type TrainRuntime } from './config';
import { clamp, forwardDistance } from './mathutil';
import { type Line, type Station } from './line';

const S = CONFIG.station;

export type StopVerdict = 'aligned' | 'overshoot' | 'short';

/**
 * 找到几何上最近的车站（双向，环线）。
 * 停车判定必须用最近站，而不是"前方第一站"——越过停车标后前方站已经是下一站。
 */
export function nearestStation(line: Line, s: number): { station: Station; signedError: number } {
  let best: Station | null = null;
  let bestAbs = Infinity;
  let bestErr = 0;
  for (const station of line.stations) {
    const err = signedStopError(line, station, s);
    if (Math.abs(err) < bestAbs) {
      bestAbs = Math.abs(err);
      best = station;
      bestErr = err;
    }
  }
  return { station: best!, signedError: bestErr };
}

/**
 * 停车判定（在列车停稳瞬间调用一次，之后状态保持到再次动车）：
 * - 停车标 ±30cm 内：aligned，屏蔽门可开
 * - 越过停车标 > 2m：overshoot，须按规定退行
 * - 其余（早停或越过 0.3~2m）：short，允许微调前进
 */
export function judgeStop(line: Line, train: TrainRuntime): StopVerdict {
  const { signedError } = nearestStation(line, train.s);
  if (Math.abs(signedError) <= S.stopTolerance) return 'aligned';
  if (signedError > S.overshootThreshold) return 'overshoot';
  return 'short';
}

/** 相对停车标的带符号误差：正=越过，负=未到 */
export function signedStopError(line: Line, station: Station, s: number): number {
  const fwd = forwardDistance(s, station.stopS, line.length);
  // 环线：取本站到下一站的前向站间距，其一半作为"已越过"判定阈值
  const idx = station.index;
  const nextStop = line.stations[(idx + 1) % line.stations.length].stopS;
  const spacing = forwardDistance(station.stopS, nextStop, line.length);
  if (fwd > spacing / 2) {
    // 越过：误差为正，大小 = 整圈 - 前向距离
    return line.length - fwd;
  }
  return -fwd;
}

/**
 * 停站流程状态机（每物理步调用）：
 * none -> 停稳判定 -> aligned/overshoot/short
 * aligned: 开门（车门+屏蔽门联动），停站计时，关门后恢复
 * overshoot: 禁止开门，要求退行；退行到位并停稳后重新判定
 */
export function updateStationStop(line: Line, train: TrainRuntime, dt: number): void {
  const stopped = Math.abs(train.v) < S.stopDetectSpeed;
  const { station, signedError: err } = nearestStation(line, train.s);
  const nearPlatform = Math.abs(err) < S.platformLength / 2 + 10;
  void station;

  // 停稳且在站台区域 -> 判定（只在刚停稳边沿；紧急制动未缓解、本站已服务时跳过）
  if (
    stopped &&
    nearPlatform &&
    train.stopStatus === 'none' &&
    !train.doorsOpen &&
    !train.emergencyApplied &&
    !train.dwellComplete
  ) {
    const verdict = judgeStop(line, train);
    train.stopStatus = verdict;
    train.stopError = err;

    if (verdict === 'aligned') {
      train.doorsOpen = true;
      train.input.doorsOpen = true;
      train.psdOpen = true;
      train.dwellRemaining = S.dwellSeconds;
      train.reversePermitted = false;
    } else if (verdict === 'overshoot') {
      // 规定：退行模式，限速 10km/h，退到窗口内重新对标
      train.reversePermitted = true;
      train.psdOpen = false;
    } else {
      // short：允许前进微调，不开门
      train.reversePermitted = false;
      train.psdOpen = false;
    }
  }

  // 停站倒计时
  if (train.doorsOpen) {
    train.dwellRemaining -= dt;
    if (train.dwellRemaining <= 0) {
      // 关门：车门与屏蔽门同步；锁存本站已服务，防止原地重新开门
      train.doorsOpen = false;
      train.input.doorsOpen = false;
      train.psdOpen = false;
      train.dwellComplete = true;
      train.stopStatus = 'none';
      train.stopError = null;
    }
  }

  // 退行/微调后再次停稳：重新判定（本站未完成服务前有效）
  if (
    stopped &&
    (train.stopStatus === 'overshoot' || train.stopStatus === 'short') &&
    !train.doorsOpen &&
    nearPlatform &&
    !train.dwellComplete
  ) {
    const verdict = judgeStop(line, train);
    train.stopStatus = verdict;
    train.stopError = err;
    if (verdict === 'aligned') {
      train.doorsOpen = true;
      train.input.doorsOpen = true;
      train.psdOpen = true;
      train.dwellRemaining = S.dwellSeconds;
      train.reversePermitted = false;
      train.input.reverseMode = false;
    }
  }

  // 停站结束（dwellComplete）后仍停在站台：标记等待发车，AI 见到此标记即牵引出站
  if (stopped && train.dwellComplete && nearPlatform && !train.doorsOpen) {
    train.stopStatus = 'none';
  }

  // short 微调中：保持 short 状态直到真正停稳，由上面的停稳分支重新判定。
  // 不能一移动就清除，否则 AI 会在"发车"与"停车"分支之间抖动。
  // 列车离开站台区域后由末尾的驶离逻辑统一清除。

  // 列车真正驶离站台区域 -> 清除对标状态并解除本站服务锁存
  if (!nearPlatform && !stopped) {
    train.stopStatus = 'none';
    train.reversePermitted = false;
    train.dwellComplete = false;
  }
}

/** 进入退行模式的合规检查：必须停稳、判为 overshoot、在站台附近 */
export function requestReverse(line: Line, train: TrainRuntime): boolean {
  const { signedError: err } = nearestStation(line, train.s);
  const stopped = Math.abs(train.v) < S.stopDetectSpeed;
  const near = Math.abs(err) < S.platformLength / 2 + 10;
  if (stopped && near && train.stopStatus === 'overshoot') {
    train.input.reverseMode = true;
    train.reversePermitted = true;
    return true;
  }
  return false;
}

export function stopStatusLabel(train: TrainRuntime): string {
  if (train.stopError === null) return '—';
  const cm = Math.round(train.stopError * 100);
  const sign = cm > 0 ? '过' : cm < 0 ? '欠' : '';
  return `${sign}${Math.abs(cm)} cm · ${train.stopStatus}`;
}

export function clampNotch(x: number): number {
  return clamp(x, 0, 1);
}
