import type { DriverInput, TrainEvent } from '../sim/types';

/**
 * Keyboard controls:
 *   W/S  traction up/down (4 notches)
 *   A/D  brake up/down (7 notches)
 *   R    reverser forward, F reverse, N neutral
 *   Space  driver emergency brake button
 *   Q    ATP EB acknowledge / confirm
 *   E    close doors
 *   X    regulated rollback after overshoot
 *   C    cycle camera
 */
export class InputController {
  private power = 0;
  private brake = 0;
  private reverser: -1 | 0 | 1 = 1;
  private ebButton = false;
  private events: TrainEvent[] = [];
  onCameraCycle: (() => void) | null = null;

  attach(target: Window): void {
    target.addEventListener('keydown', (e) => this.handle(e, true));
    target.addEventListener('keyup', (e) => this.handle(e, false));
  }

  private handle(e: KeyboardEvent, down: boolean): void {
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', ' ', 'r', 'f', 'n', 'q', 'e', 'x', 'c'].includes(k)) {
      e.preventDefault();
    }
    if (!down) {
      if (k === ' ') this.ebButton = false;
      return;
    }
    switch (k) {
      case 'w':
        this.power = Math.min(4, this.power + 1);
        break;
      case 's':
        this.power = Math.max(0, this.power - 1);
        break;
      case 'd':
        this.brake = Math.min(7, this.brake + 1);
        break;
      case 'a':
        this.brake = Math.max(0, this.brake - 1);
        break;
      case 'r':
        this.reverser = 1;
        break;
      case 'f':
        this.reverser = -1;
        break;
      case 'n':
        this.reverser = 0;
        break;
      case ' ':
        this.ebButton = true;
        break;
      case 'q':
        this.events.push('confirm');
        break;
      case 'e':
        this.events.push('closeDoors');
        break;
      case 'x':
        this.events.push('rollback');
        break;
      case 'c':
        this.onCameraCycle?.();
        break;
    }
  }

  sample(): DriverInput {
    return {
      power: this.power,
      brake: this.brake,
      reverser: this.reverser,
      ebButton: this.ebButton,
      targetDecel: null,
    };
  }

  drainEvents(): TrainEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
