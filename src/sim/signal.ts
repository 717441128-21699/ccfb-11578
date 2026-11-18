import { CONFIG } from './config';
import { forwardDistance } from './mathutil';
import { blockIndexAt, type Block, type Line } from './line';
import type { TrainRuntime } from './config';

export type Aspect = 'GREEN' | 'YELLOW' | 'RED' | 'NONE';

export interface BlockState {
  blockId: number;
  occupiedBy: number | null; // train id
}

export interface Authority {
  /** 授权终点绝对里程（环线） */
  endS: number;
  /** 距车头距离 m */
  distance: number;
  /** 授权终点所在分区 id */
  endBlockId: number;
  /** 阻挡来源：前车 id / 终点停车标 / null（全线空闲） */
  blockedBy: number | null;
}

/**
 固定闭塞（带逻辑占用）信号系统：
 - 列车占用其车头、车尾覆盖的所有分区；
 - 后车移动授权终点 = 前车车尾所在分区的边界（保留一个防护分区）；
 - 信号机设于每个分区入口，三显示。
 */
export class SignalSystem {
  readonly states: BlockState[];
  private line: Line;

  constructor(line: Line) {
    this.line = line;
    this.states = line.blocks.map((b) => ({ blockId: b.id, occupiedBy: null }));
  }

  reset(): void {
    for (const st of this.states) st.occupiedBy = null;
  }

  /** 每步先全量重算占用（12 列车、分区数量有限，直接扫） */
  updateOccupancy(trains: TrainRuntime[]): void {
    for (const st of this.states) st.occupiedBy = null;
    for (const tr of trains) {
      const headIdx = blockIndexAt(this.line, tr.s);
      const tailS = tr.s - CONFIG.train.length;
      const tailIdx = blockIndexAt(this.line, tailS);
      const count = this.line.blocks.length;
      let i = tailIdx;
      let guard = 0;
      while (guard++ < count + 2) {
        this.states[i].occupiedBy = tr.id;
        if (i === headIdx) break;
        i = (i + 1) % count;
      }
    }
  }

  /** 计算一列车的移动授权 */
  authorityFor(train: TrainRuntime): Authority {
    const line = this.line;
    const headIdx = blockIndexAt(line, train.s);
    const count = line.blocks.length;

    // 入侵防护：车头所在分区已被其他车占用 -> 授权终点即当前位置（距离 0），
    // ATP 曲线立刻要求停车，杜绝越过前车。
    const headOwner = this.states[headIdx].occupiedBy;
    if (headOwner !== null && headOwner !== train.id) {
      return {
        endS: train.s,
        distance: 0,
        endBlockId: line.blocks[headIdx].id,
        blockedBy: headOwner,
      };
    }

    // 从车头所在分区的下一个分区开始向前找占用分区
    let probe = (headIdx + 1) % count;
    let guard = 0;
    while (guard++ < count) {
      const occ = this.states[probe].occupiedBy;
      if (occ !== null && occ !== train.id) {
        // 回溯该车连续占用区的最后端（列车可能横跨多个短分区）
        let rearmost = probe;
        let g2 = 0;
        while (g2++ < count) {
          const prev = (rearmost - 1 + count) % count;
          if (this.states[prev].occupiedBy === occ) rearmost = prev;
          else break;
        }
        // 授权终点 = 占用区最后端分区的前一个分区边界
        const guardBlock: Block = line.blocks[(rearmost - 1 + count) % count];
        const endS = guardBlock.endS % line.length;
        return {
          endS,
          distance: forwardDistance(train.s, endS, line.length),
          endBlockId: guardBlock.id,
          blockedBy: occ,
        };
      }
      probe = (probe + 1) % count;
    }

    // 全线无其他车：授权到前方站台停车标（车载 ATO 停车目标）
    return {
      endS: train.authorityEnd ?? train.s,
      distance: forwardDistance(train.s, train.authorityEnd ?? train.s, line.length),
      endBlockId: -1,
      blockedBy: null,
    };
  }

  /**
   * 信号机显示：取列车前方最近分区入口信号。
   * RED=下一分区占用；YELLOW=再下一分区占用；GREEN=空闲。
   */
  aspectAhead(train: TrainRuntime): Aspect {
    const line = this.line;
    const headIdx = blockIndexAt(line, train.s);
    const count = line.blocks.length;
    const next = (headIdx + 1) % count;
    const after = (headIdx + 2) % count;

    const occNext = this.states[next].occupiedBy;
    if (occNext !== null && occNext !== train.id) return 'RED';
    const occAfter = this.states[after].occupiedBy;
    if (occAfter !== null && occAfter !== train.id) return 'YELLOW';
    return 'GREEN';
  }

  /** 指定分区入口信号机的显示（渲染用） */
  aspectAtBlock(blockIdx: number, selfTrainId: number): Aspect {
    const count = this.states.length;
    const next = (blockIdx + 1) % count;
    const after = (blockIdx + 2) % count;
    const occNext = this.states[next].occupiedBy;
    if (occNext !== null && occNext !== selfTrainId) return 'RED';
    const occAfter = this.states[after].occupiedBy;
    if (occAfter !== null && occAfter !== selfTrainId) return 'YELLOW';
    return 'GREEN';
  }
}
