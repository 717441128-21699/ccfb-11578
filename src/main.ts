import { World } from './sim/world';
import { SIM_DT } from './sim/constants';
import { Renderer } from './render/renderer';
import { Hud } from './render/hud';
import { InputController } from './render/input';

const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement | null;
if (!canvas || !hudCanvas) throw new Error('Missing canvas elements');

const world = new World();
const renderer = new Renderer(canvas, world.line);
const hudCanvasEl: HTMLCanvasElement = hudCanvas;
const hud = new Hud(hudCanvasEl);
const input = new InputController();
input.attach(window);
input.onCameraCycle = () => renderer.cycleCamera();

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.resize(w, h);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  hudCanvasEl.width = Math.floor(w * dpr);
  hudCanvasEl.height = Math.floor(h * dpr);
  hudCanvasEl.style.width = `${w}px`;
  hudCanvasEl.style.height = `${h}px`;
}
window.addEventListener('resize', resize);
resize();

// Fixed-step accumulator: the simulation always advances in exact SIM_DT
// increments regardless of display refresh rate, guaranteeing >=60 updates/s.
let accumulator = 0;
let last = performance.now();
let fpsFrames = 0;
let fpsTime = 0;

function frame(now: number): void {
  const elapsed = Math.min(0.1, (now - last) / 1000);
  last = now;
  accumulator += elapsed;

  // Player intent is latched and stays until the driver changes a notch.
  world.setPlayerInput(input.sample());
  for (const ev of input.drainEvents()) world.playerEvent(ev);

  let guard = 0;
  while (accumulator >= SIM_DT && guard < 300) {
    world.step();
    accumulator -= SIM_DT;
    guard++;
  }

  const snap = world.getSnapshot();
  const player = snap.trains[snap.playerId];
  const sig = world.signals.nextSignal(player.trackId, player.front, player.direction);
  renderer.render(snap, [world.signals.getSignals(0), world.signals.getSignals(1)]);
  hud.render(snap, sig?.aspect ?? null);

  fpsFrames++;
  fpsTime += elapsed;
  if (fpsTime >= 1) {
    document.getElementById('fps')!.textContent =
      `FPS ${fpsFrames}  仿真 ${Math.round(1 / SIM_DT)} Hz  列车 ${snap.trains.length}`;
    fpsFrames = 0;
    fpsTime = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
