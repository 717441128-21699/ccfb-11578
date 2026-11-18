import type { World } from '../sim/world';
import { stopStatusLabel } from '../sim/station';
import { sampleCurve } from '../sim/atp';

const $ = (id: string) => document.getElementById(id)!;

function kmh(v: number): string {
  return (v * 3.6).toFixed(0);
}

export class Hud {
  private els = {
    speed: $('hud-speed'),
    traction: $('hud-traction'),
    brake: $('hud-brake'),
    load: $('hud-load'),
    ftrac: $('hud-ftrac'),
    fed: $('hud-fed'),
    fair: $('hud-fair'),
    grade: $('hud-grade'),
    radius: $('hud-radius'),
    vtarget: $('hud-vtarget'),
    distStation: $('hud-dist-station'),
    distMa: $('hud-dist-ma'),
    signal: $('hud-signal'),
    doors: $('hud-doors'),
    stop: $('hud-stop'),
    atp: $('hud-atp-state'),
    message: $('hud-message'),
    simhz: $('hud-simhz'),
    fps: $('hud-fps'),
  };

  private messageTimer = 0;

  flash(msg: string, ms = 2600): void {
    this.els.message.textContent = msg;
    this.messageTimer = ms;
  }

  update(world: World, dtMs: number, simHz: number, fps: number): void {
    const p = world.player;
    this.els.speed.textContent = kmh(Math.abs(p.v));
    this.els.traction.textContent = `${Math.round(p.input.tractionNotch * 100)}%`;
    this.els.brake.textContent = `${Math.round(p.input.brakeNotch * 100)}%`;
    this.els.load.textContent = p.load === 'AW3' ? '满载 AW3' : '空载 AW0';
    this.els.ftrac.textContent = (p.tractionForce / 1000).toFixed(1);
    this.els.fed.textContent = (p.edBrakeForce / 1000).toFixed(1);
    this.els.fair.textContent = (p.airBrakeForce / 1000).toFixed(1);
    this.els.grade.textContent = p.grade.toFixed(0);
    this.els.radius.textContent = p.curveRadius === null ? '—' : `${p.curveRadius} m`;
    this.els.vtarget.textContent = kmh(p.supervisedSpeed);
    this.els.distStation.textContent = `${world.line.stations[p.nextStationIndex].name} · ${Math.max(0, forwardDist(world, p.nextStationIndex)).toFixed(0)} m`;
    this.els.distMa.textContent = p.authorityDistance.toFixed(0);
    this.els.signal.textContent = aspectLabel(p.nextSignalAspect);
    this.els.doors.textContent = p.psdOpen
      ? `车门+屏蔽门开启 (${p.dwellRemaining.toFixed(0)}s)`
      : p.doorsOpen
        ? '车门开启'
        : '关闭';
    this.els.stop.textContent = stopStatusLabel(p);

    const atpEl = this.els.atp;
    if (p.emergencyApplied) {
      atpEl.innerHTML = '<span class="eb">⚠ ATP 紧急制动已施加 · 停稳后按空格确认缓解</span>';
    } else if (p.atpAlarm) {
      atpEl.innerHTML = '<span class="alarm">⚠ 超速报警：立即减速！</span>';
    } else {
      atpEl.innerHTML = '<span class="ok">ATP 正常监督</span>';
    }

    this.els.simhz.textContent = simHz.toFixed(0);
    this.els.fps.textContent = fps.toFixed(0);

    if (this.messageTimer > 0) {
      this.messageTimer -= dtMs;
    }
  }

  /** 迷你速度-曲线仪表（canvas 2D 叠加） */
  drawCurve(canvas: HTMLCanvasElement, world: World): void {
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const p = world.player;
    const curve = sampleCurve(world.line, p, {
      endS: p.authorityEnd,
      distance: p.authorityDistance,
      endBlockId: -1,
      blockedBy: null,
    }, 600, 10);

    const vMax = 25; // m/s 对应 90km/h
    const dMax = 600;
    const x = (d: number) => (d / dMax) * W;
    const y = (v: number) => H - (Math.min(v, vMax) / vMax) * H;

    // 监督曲线
    ctx.beginPath();
    curve.forEach((pt, i) => {
      if (i === 0) ctx.moveTo(x(pt.d), y(pt.v));
      else ctx.lineTo(x(pt.d), y(pt.v));
    });
    ctx.strokeStyle = '#ffb02e';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 当前速度点
    ctx.beginPath();
    ctx.arc(x(0), y(Math.abs(p.v)), 4, 0, Math.PI * 2);
    ctx.fillStyle = p.atpAlarm || p.emergencyApplied ? '#ff4d4d' : '#5fd3ff';
    ctx.fill();

    // 刻度
    ctx.fillStyle = '#9fb3c8';
    ctx.font = '10px monospace';
    for (let v = 0; v <= 80; v += 20) {
      ctx.fillText(`${v}`, 2, y(v / 3.6) - 2);
    }
  }
}

function aspectLabel(a: string): string {
  switch (a) {
    case 'RED': return '🔴 红灯（前方分区占用）';
    case 'YELLOW': return '🟡 黄灯（注意）';
    case 'GREEN': return '🟢 绿灯';
    default: return '—';
  }
}

function forwardDist(world: World, stationIdx: number): number {
  const stopS = world.line.stations[stationIdx].stopS;
  const s = world.player.s;
  return (stopS - s + world.line.length) % world.line.length;
}
