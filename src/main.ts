import { World } from './sim/world';
import { CONFIG } from './sim/config';
import { catchUpSteps, clamp } from './sim/mathutil';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { requestReverse } from './sim/station';
import './ui/style.css';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const world = new World();
const renderer = new Renderer(canvas, world.line);
const hud = new Hud();

// 迷你制动曲线仪表
const curveCanvas = document.createElement('canvas');
curveCanvas.id = 'curve-meter';
curveCanvas.width = 220;
curveCanvas.height = 110;
document.body.appendChild(curveCanvas);

// ---------- 输入 ----------
const STEP = 0.1;
const keys = new Set<string>();

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
  keys.add(e.code);

  const p = world.player;
  switch (e.code) {
    case 'KeyW':
      p.input.tractionNotch = clamp(p.input.tractionNotch + STEP, 0, 1);
      if (p.input.tractionNotch > 0) p.input.brakeNotch = 0;
      break;
    case 'KeyS':
      p.input.tractionNotch = clamp(p.input.tractionNotch - STEP, 0, 1);
      break;
    case 'ArrowUp':
      p.input.brakeNotch = clamp(p.input.brakeNotch + STEP, 0, 1);
      if (p.input.brakeNotch > 0) p.input.tractionNotch = 0;
      break;
    case 'ArrowDown':
      p.input.brakeNotch = clamp(p.input.brakeNotch - STEP, 0, 1);
      break;
    case 'Backspace':
      p.input.tractionNotch = 0;
      p.input.brakeNotch = 0;
      break;
    case 'Space':
      if (p.emergencyApplied) {
        world.acknowledgeEmergency();
        hud.flash('已执行紧急制动缓解确认');
      } else {
        p.emergencyApplied = true;
        p.input.emergencyBrake = true;
        hud.flash('人工紧急制动施加');
      }
      break;
    case 'KeyT':
      if (Math.abs(p.v) < CONFIG.station.stopDetectSpeed && p.stopStatus === 'aligned') {
        hud.flash('开关门由停站流程自动管理（停站 20s）');
      } else {
        hud.flash('未对标停车，车门封锁');
      }
      break;
    case 'KeyR':
      if (requestReverse(world.line, p)) hud.flash('退行模式：限速 10 km/h，退至停车标窗口内');
      else hud.flash('当前不允许退行（须停稳且判定为停过标）');
      break;
    case 'KeyL': {
      const load = world.togglePlayerLoad();
      hud.flash(`载荷切换为 ${load === 'AW3' ? '满载 AW3' : '空载 AW0'}（须停稳）`);
      break;
    }
    case 'KeyC':
      hud.flash(`视角：${renderer.toggleMode()}`);
      break;
    case 'Digit1':
      world.triggerObstacleTest();
      hud.flash('测试场景：前车区间紧急停车，注意 ATP 制动曲线！');
      break;
  }
});

window.addEventListener('keyup', (e) => keys.delete(e.code));

// ---------- 固定步长主循环 ----------
const dt = CONFIG.sim.dt;
let last = performance.now();
let acc = 0;
let frames = 0;
let fpsTimer = 0;
let fps = 0;
let simStepsWindow = 0;
let simHzTimer = 0;
let simHz = 0;

function frame(now: number): void {
  const frameMs = now - last;
  last = now;
  acc += Math.min(frameMs, 250) / 1000; // 切后台后防止螺旋追帧

  const { steps, acc: left } = catchUpSteps(acc, dt, 240);
  acc = left;
  for (let i = 0; i < steps; i++) world.step();
  simStepsWindow += steps;

  renderer.render(world);
  hud.update(world, frameMs, simHz, fps);
  hud.drawCurve(curveCanvas, world);

  frames++;
  fpsTimer += frameMs;
  simHzTimer += frameMs;
  if (fpsTimer >= 500) {
    fps = (frames * 1000) / fpsTimer;
    frames = 0;
    fpsTimer = 0;
    simHz = (simStepsWindow * 1000) / simHzTimer;
    simStepsWindow = 0;
    simHzTimer = 0;
  }
  requestAnimationFrame(frame);
}

hud.flash('仿真启动：W/S 牵引，↑/↓ 制动，红灯闯不过去——ATP 会拦你');
requestAnimationFrame(frame);
