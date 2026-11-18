/**
 * 全局可调参数（SI 单位：m, m/s, kg, N, rad）。
 */

export const CONFIG = {
  sim: {
    /** 固定物理步进（120Hz，满足"每秒不少于 60 次更新"） */
    dt: 1 / 120,
  },

  train: {
    cars: 6,
    length: 118, // 车列长度（车头到车尾），m
    /** 空载 AW0 / 满载 AW3 质量 */
    massEmpty: 204_000,
    massFull: 324_000,

    maxSpeed: 22.22, // 80 km/h

    // 牵引特性：低速恒牵引力，高于转折速度按恒功率衰减
    maxTractionForce: 320_000, // N（手柄 100% 时低速段）
    tractionKneeSpeed: 11.11, // 40 km/h 转折
    tractionLag: 0.6, // 牵引力一阶惯性时间常数 s

    // 电制动（再生/电阻）：中高速有效，低速退出
    maxEdBrakeForce: 260_000, // N
    edBrakeKneeSpeed: 13.89, // 50 km/h 以下按比例衰减
    edBrakeFadeSpeed: 1.5, // 1.5 m/s 完全退出，交空气制动
    // 空气制动
    maxAirBrakeForce: 230_000, // 常用制动空气补充上限
    emergencyBrakeForce: 430_000, // 纯空气紧急制动
    brakeBuildLag: 0.9, // 常用空气制动建立慢
    emergencyBuildLag: 0.3, // 紧急制动直通快速充风
    edBrakeLag: 0.25,
    brakeReleaseLag: 1.2, // 缓解更慢

    // 单位基本阻力 Davis: R = a + b v + c v^2 (N/t)，每吨
    davisA: 2.9,
    davisB: 0.022,
    davisC: 0.000_42,

    rollbackHoldForce: 120_000, // 静止保持制动力 N（覆盖最大坡道重力分力）
    reverseSpeedLimit: 2.78, // 退行限速 10 km/h
  },

  atp: {
    /** 制动曲线使用的保证减速度（保守：考虑满载、湿轨、制动缸建立迟滞） */
    guaranteedDecel: 0.7,
    /** 安全防护距离：曲线要求在授权终点前这么多米就停住 */
    safetyDistance: 80,
    alarmMargin: 2.0 / 3.6, // 超过监督速度 2km/h 触发声光报警
    ebMargin: 4.0 / 3.6, // 超过 4km/h（或曲线外推侵限）触发紧急制动
    targetLookahead: 2600, // 曲线生成前方搜索范围 m
    stationApproachWindow: 900, // 站内停车目标生效窗口 m
  },

  station: {
    platformLength: 140,
    stopTolerance: 0.3, // 停车标 ±30 cm
    dwellSeconds: 20,
    stopDetectSpeed: 0.08, // 判停速度 m/s
    overshootThreshold: 2.0, // 越过停车标 2m 才判"停过"
  },

  line: {
    stationCount: 20,
    trainCount: 12,
    blockNominalLength: 300, // 区间闭塞分区标称长度
    signalSpacingBlock: 1, // 每个闭塞分区入口一架信号机
  },
} as const;

export type LoadState = 'AW0' | 'AW3';

export interface TrainInput {
  /** 牵引手柄 0..1（与制动手柄互斥） */
  tractionNotch: number;
  /** 制动手柄 0..1（常用制动） */
  brakeNotch: number;
  /** 紧急制动请求（人工或 ATP） */
  emergencyBrake: boolean;
  /** 退行模式（仅停稳后允许进入，限速 10km/h） */
  reverseMode: boolean;
  /** 车门开（此时牵引封锁） */
  doorsOpen: boolean;
}

export interface TrainRuntime {
  id: number;
  name: string;
  isPlayer: boolean;
  load: LoadState;

  /** 车头在线路里程上的位置（m，环线，对线路总长取模） */
  s: number;
  /** 带符号速度，正向为正，后退为负 m/s */
  v: number;
  /** 实际牵引力 N（带惯性） */
  tractionForce: number;
  /** 实际电制动力 N */
  edBrakeForce: number;
  /** 实际空气制动力 N（常用） */
  airBrakeForce: number;
  /** 实际紧急制动力 N（独立纯空气回路） */
  emergencyForce: number;
  emergencyApplied: boolean;
  /** 紧急制动后停稳确认（玩家按空格 / AI 自检） */
  ebAck: boolean;

  input: TrainInput;

  // ATP 输出
  atpAlarm: boolean;
  atpEmergency: boolean;
  /** 当前监督速度（HUD 显示的"制动曲线速度"）m/s */
  supervisedSpeed: number;
  /** 移动授权终点里程（环线绝对里程） */
  authorityEnd: number;
  /** 距授权终点的纵向距离 m */
  authorityDistance: number;
  nextSignalAspect: 'GREEN' | 'YELLOW' | 'RED' | 'NONE';

  // 对标 / 站台
  nextStationIndex: number;
  doorsOpen: boolean;
  dwellRemaining: number;
  /** 本站台已完成停站作业，驶离前不得再次开门 */
  dwellComplete: boolean;
  stopError: number | null; // 最近一次停车对标误差 m
  stopStatus: 'none' | 'aligned' | 'overshoot' | 'short';
  reversePermitted: boolean;
  psdOpen: boolean;

  // 诊断
  grade: number; // ‰
  curveRadius: number | null;
  totalResistance: number;
  mass: number;
}

export function massFor(load: LoadState): number {
  return load === 'AW0' ? CONFIG.train.massEmpty : CONFIG.train.massFull;
}
