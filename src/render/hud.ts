import type { WorldSnapshot } from '../sim/world';
import type { TrainSnapshot } from '../sim/train';
import { MAX_SPEED, STOP_TOLERANCE } from '../sim/constants';

/**
 * 2D canvas HUD drawn on top of the WebGL view: speedometer, ATP brake-curve
 * strip, signal repeater, EB/alarm status and platform stopping accuracy.
 */
export class Hud {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  render(snap: WorldSnapshot, nextAspect: string | null): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const p = snap.trains[snap.playerId];
    this.drawSpeedometer(ctx, p, h);
    this.drawBrakeStrip(ctx, p, h);
    this.drawSignalRepeater(ctx, nextAspect, w, h);
    this.drawStatus(ctx, p);
  }

  private drawSpeedometer(ctx: CanvasRenderingContext2D, p: TrainSnapshot, h: number): void {
    const cx = 110;
    const cy = h - 110;
    const r = 80;
    const kmh = Math.abs(p.speed) * 3.6;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,14,20,0.78)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2c3a4d';
    ctx.stroke();

    // Arc from -225deg to 45deg.
    const start = Math.PI * 0.75;
    const end = Math.PI * 2.25;
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#243244';
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, end);
    ctx.stroke();

    // Filled portion proportional to speed.
    const frac = Math.min(1, kmh / (MAX_SPEED * 3.6));
    ctx.strokeStyle = p.atp.alarm ? '#ff5a4d' : '#39d98a';
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + (end - start) * frac);
    ctx.stroke();

    // Digital readout.
    ctx.fillStyle = '#e8eef6';
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(kmh)).padStart(2, '0'), cx, cy + 8);
    ctx.font = '13px monospace';
    ctx.fillStyle = '#8aa0b8';
    ctx.fillText('km/h', cx, cy + 28);

    // Limit marker.
    const limitKmh = Math.round(p.atp.lineLimit * 3.6);
    ctx.fillStyle = '#ffd34d';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(`LIM ${limitKmh}`, cx, cy - r + 18);
    ctx.restore();
  }

  private drawBrakeStrip(ctx: CanvasRenderingContext2D, p: TrainSnapshot, h: number): void {
    const x = 230;
    const y = h - 180;
    const width = 300;
    const height = 130;
    ctx.save();
    ctx.fillStyle = 'rgba(10,14,20,0.78)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#2c3a4d';
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = '#8aa0b8';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('ATP 制动防护曲线', x + 10, y + 18);

    // Plot the supervision curve over the next 600 m.
    const horizon = 600;
    const plotX = x + 14;
    const plotW = width - 28;
    const plotY = y + 30;
    const plotH = height - 44;
    const vMax = MAX_SPEED * 3.6;

    ctx.strokeStyle = '#3a4a5e';
    ctx.beginPath();
    ctx.moveTo(plotX, plotY + plotH);
    ctx.lineTo(plotX + plotW, plotY + plotH);
    ctx.moveTo(plotX, plotY);
    ctx.lineTo(plotX, plotY + plotH);
    ctx.stroke();

    const targets = p.atp.targets.filter((t) => t.s <= horizon);
    const curve = (dist: number): number => {
      let result = Infinity;
      for (const t of targets) {
        const d = t.s - dist;
        if (d <= 0) result = Math.min(result, t.v);
        else result = Math.min(result, Math.sqrt(t.v * t.v + 2 * 1.0 * d));
      }
      return Number.isFinite(result) ? result : p.atp.lineLimit;
    };

    ctx.strokeStyle = '#ff7a5c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let d = 0; d <= horizon; d += 10) {
      const v = curve(d) * 3.6;
      const px = plotX + (d / horizon) * plotW;
      const py = plotY + plotH - Math.min(1, v / vMax) * plotH;
      if (d === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Current speed marker.
    const curKmh = Math.abs(p.speed) * 3.6;
    const my = plotY + plotH - Math.min(1, curKmh / vMax) * plotH;
    ctx.fillStyle = p.atp.emergencyActive ? '#ff3b30' : '#7fd4ff';
    ctx.beginPath();
    ctx.arc(plotX, my, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawSignalRepeater(ctx: CanvasRenderingContext2D, aspect: string | null, w: number, h: number): void {
    const x = w - 130;
    const y = h - 180;
    ctx.save();
    ctx.fillStyle = 'rgba(10,14,20,0.78)';
    ctx.fillRect(x, y, 100, 130);
    ctx.strokeStyle = '#2c3a4d';
    ctx.strokeRect(x, y, 100, 130);
    ctx.fillStyle = '#8aa0b8';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('信号', x + 50, y + 18);

    const colors: Record<string, string> = { red: '#ff3b30', yellow: '#ffd23f', green: '#37e06b' };
    const order = ['red', 'yellow', 'green'];
    order.forEach((name, i) => {
      const cy = y + 42 + i * 30;
      ctx.beginPath();
      ctx.arc(x + 30, cy, 11, 0, Math.PI * 2);
      ctx.fillStyle = aspect === name ? colors[name] : '#2a3646';
      ctx.fill();
      ctx.fillStyle = '#8aa0b8';
      ctx.textAlign = 'left';
      ctx.fillText(name === 'red' ? '红' : name === 'yellow' ? '黄' : '绿', x + 50, cy + 4);
    });
    ctx.restore();
  }

  private drawStatus(ctx: CanvasRenderingContext2D, p: TrainSnapshot): void {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = '14px monospace';
    const lines: string[] = [];
    lines.push(`列车 ${p.label}  载荷 ${loadText(p.load)}  质量 ${(p.mass / 1000).toFixed(0)} t`);
    lines.push(`阶段 ${phaseText(p.phase)}  方向 ${p.direction > 0 ? '上行' : '下行'}  里程 ${p.front.toFixed(1)} m`);
    if (p.stopError !== null) {
      lines.push(`对标误差 ${(p.stopError * 100).toFixed(1)} cm（容差 ±${STOP_TOLERANCE * 100} cm）`);
    }
    if (p.atp.emergencyActive) {
      lines.push(p.atp.awaitConfirm ? '★ 紧急制动已停车，按 Q 确认缓解 ★' : '★★ 紧急制动触发 ★★');
    } else if (p.atp.alarm) {
      lines.push('⚠ 超速报警：请立即减速 ⚠');
    }
    if (p.overshoot) lines.push('停车过标，需按规定退行（反向器+牵引，限速 5 km/h）');
    if (p.doorsOpen) lines.push(`屏蔽门开启中，剩余 ${p.dwellRemaining.toFixed(0)} s`);

    let y = 20;
    for (const line of lines) {
      const danger = line.includes('★') || line.includes('⚠');
      ctx.fillStyle = danger ? '#ff6b5e' : '#cfe0f2';
      ctx.fillText(line, 20, y);
      y += 22;
    }
    ctx.restore();
  }
}

function loadText(load: string): string {
  return load === 'empty' ? '空载 AW0' : load === 'half' ? '半载 AW2' : '满载 AW3';
}

function phaseText(phase: string): string {
  if (phase === 'running') return '运行';
  if (phase === 'dwell') return '停站';
  return '折返';
}
