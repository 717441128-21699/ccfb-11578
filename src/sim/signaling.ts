import { SAFETY_MARGIN } from './constants';
import type { Line } from './line';
import type { BlockDef, MovementAuthority, TrackId } from './types';

export type SignalAspect = 'green' | 'yellow' | 'red';

export interface SignalState {
  /** Chainage of the signal (it guards the block starting there). */
  chainage: number;
  blockId: number;
  aspect: SignalAspect;
}

/**
 * Fixed-block signal system. A train occupies every block overlapped by its
 * length; a following train's movement authority ends at the entry of the
 * first occupied block ahead (with a safety margin).
 */
export class SignalSystem {
  /** trackId -> blockId -> true while a train occupies the block. */
  private occupancy: Set<number>[] = [new Set(), new Set()];
  private signals: SignalState[][] = [[], []];

  constructor(private readonly line: Line) {
    for (const trackId of [0, 1] as TrackId[]) {
      this.signals[trackId] = line.blocks[trackId].map((b) => ({
        chainage: b.start,
        blockId: b.id,
        aspect: 'green' as SignalAspect,
      }));
    }
  }

  clear(): void {
    this.occupancy[0].clear();
    this.occupancy[1].clear();
  }

  markOccupied(trackId: TrackId, blockIds: readonly number[]): void {
    const set = this.occupancy[trackId];
    for (const id of blockIds) set.add(id);
  }

  isOccupied(trackId: TrackId, blockId: number): boolean {
    return this.occupancy[trackId].has(blockId);
  }

  occupiedBlocks(trackId: TrackId): number[] {
    return [...this.occupancy[trackId]];
  }

  /**
   * Movement authority for a train whose front is in `frontBlock`.
   * Scans blocks ahead in the travel direction until the first occupied one.
   */
  authorityFor(
    trackId: TrackId,
    frontBlock: BlockDef | null,
    direction: 1 | -1,
    frontChainage: number,
  ): MovementAuthority {
    if (!frontBlock) {
      return { endChainage: frontChainage, distance: 0, valid: false };
    }
    const blocks = this.line.blocks[trackId];
    let idx = frontBlock.id;
    let endChainage: number | null = null;

    while (idx >= 0 && idx < blocks.length) {
      const b = blocks[idx];
      if (this.occupancy[trackId].has(b.id) && b.id !== frontBlock.id) {
        endChainage = direction > 0 ? b.start : b.end;
        break;
      }
      idx += direction;
    }

    if (endChainage === null) {
      // No train ahead: authority reaches the track end.
      const last = blocks[blocks.length - 1];
      endChainage = direction > 0 ? last.end : blocks[0].start;
    } else {
      endChainage -= direction * SAFETY_MARGIN;
    }

    const distance = (endChainage - frontChainage) * direction;
    return { endChainage, distance: Math.max(0, distance), valid: distance > 0 };
  }

  /**
   * Three-aspect signalling: red if the block the signal guards is occupied,
   * yellow if the next block is occupied, otherwise green.
   */
  refreshAspects(): void {
    for (const trackId of [0, 1] as TrackId[]) {
      const blocks = this.line.blocks[trackId];
      for (const sig of this.signals[trackId]) {
        const id = sig.blockId;
        if (this.occupancy[trackId].has(id)) {
          sig.aspect = 'red';
        } else if (id + 1 < blocks.length && this.occupancy[trackId].has(id + 1)) {
          sig.aspect = 'yellow';
        } else {
          sig.aspect = 'green';
        }
      }
    }
  }

  getSignals(trackId: TrackId): readonly SignalState[] {
    return this.signals[trackId];
  }

  /** Nearest signal at or ahead of the given chainage in the travel direction. */
  nextSignal(trackId: TrackId, chainage: number, direction: 1 | -1): SignalState | null {
    const list = this.signals[trackId];
    if (direction > 0) {
      for (const sig of list) {
        if (sig.chainage >= chainage) return sig;
      }
    } else {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].chainage <= chainage) return list[i];
      }
    }
    return null;
  }
}
