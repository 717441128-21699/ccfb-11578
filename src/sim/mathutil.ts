export const TAU = Math.PI * 2;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 一阶惯性环节离散更新：y 以时间常数 tau 趋近目标 target */
export function approachFirstOrder(y: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return y + (target - y) * k;
}

/**
 * 环线上从 a 到 b 的前向有向距离（恒为 0..L）。
 */
export function forwardDistance(a: number, b: number, length: number): number {
  return (b - a + length) % length;
}

/** 环线最短有向差（带符号，-L/2..L/2） */
export function wrapDelta(d: number, length: number): number {
  let x = d % length;
  if (x > length / 2) x -= length;
  if (x < -length / 2) x += length;
  return x;
}

/** 固定步长积分器的追赶逻辑：返回本帧应执行的物理步数 */
export function catchUpSteps(accumulator: number, dt: number, maxSteps: number): { steps: number; acc: number } {
  let steps = Math.floor(accumulator / dt);
  if (steps > maxSteps) steps = maxSteps;
  return { steps, acc: accumulator - steps * dt };
}
