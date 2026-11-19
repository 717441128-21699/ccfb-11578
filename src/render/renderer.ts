import {
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  mat4RotateY,
  mat4Translate,
  type Vec3,
} from './math3d';
import {
  buildGroundMesh,
  buildSignalLamps,
  buildSignalMesh,
  buildStationMesh,
  buildTrackMesh,
  buildTrainMesh,
  buildUnitCubeMesh,
  type LampInstance,
} from './mesh';
import { createInstancedCube, createProgram, uniformLoc, uploadMesh, type GpuMesh, type InstancedMesh } from './gl';
import { BASIC_FRAG, BASIC_VERT, LAMP_FRAG, LAMP_VERT } from './shaders';
import type { Line } from '../sim/line';
import { geometryAt } from '../sim/line';
import type { WorldSnapshot } from '../sim/world';
import type { TrainSnapshot } from '../sim/train';
import type { SignalState } from '../sim/signaling';

export type CameraMode = 'cab' | 'chase' | 'orbit';

const SIGNAL_COLORS: Record<string, [number, number, number]> = {
  red: [1.0, 0.12, 0.08],
  yellow: [1.0, 0.75, 0.1],
  green: [0.15, 0.95, 0.3],
};

const TRAIN_COLORS: [number, number, number][] = [
  [0.85, 0.85, 0.88],
  [0.78, 0.2, 0.22],
  [0.2, 0.45, 0.8],
  [0.25, 0.65, 0.45],
];

export class Renderer {
  private gl: WebGL2RenderingContext;
  private basicProg: WebGLProgram;
  private lampProg: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private lampU: Record<string, WebGLUniformLocation | null> = {};
  private ground: GpuMesh;
  private track: GpuMesh;
  private stations: GpuMesh;
  private signals: GpuMesh;
  private trainMeshes: GpuMesh[] = [];
  private lampMesh: InstancedMesh;
  private lamps: LampInstance[];
  private line: Line;
  cameraMode: CameraMode = 'chase';
    private orbitAngle = 0.6;
  private orbitDistance = 90;

  constructor(canvas: HTMLCanvasElement, line: Line) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.line = line;

    this.basicProg = createProgram(gl, BASIC_VERT, BASIC_FRAG);
    this.lampProg = createProgram(gl, LAMP_VERT, LAMP_FRAG);
    for (const name of ['uViewProj', 'uModel', 'uLightDir', 'uFogColor', 'uFogStart', 'uFogEnd']) {
      this.u[name] = uniformLoc(gl, this.basicProg, name);
    }
    for (const name of ['uViewProj', 'uModel', 'uLampColor', 'uIntensity']) {
      this.lampU[name] = uniformLoc(gl, this.lampProg, name);
    }

    this.ground = uploadMesh(gl, buildGroundMesh(line));
    this.track = uploadMesh(gl, buildTrackMesh(line));
    this.stations = uploadMesh(gl, buildStationMesh(line));
    this.signals = uploadMesh(gl, buildSignalMesh(line));
    for (const c of TRAIN_COLORS) this.trainMeshes.push(uploadMesh(gl, buildTrainMesh(c)));

    this.lamps = buildSignalLamps(line);
    this.lampMesh = createInstancedCube(gl, buildUnitCubeMesh(), this.lamps.length);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.09, 0.11, 0.15, 1);
  }

  resize(width: number, height: number): void {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    gl.canvas.width = Math.floor(width * dpr);
    gl.canvas.height = Math.floor(height * dpr);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  }

  cycleCamera(): void {
    const order: CameraMode[] = ['chase', 'cab', 'orbit'];
    this.cameraMode = order[(order.indexOf(this.cameraMode) + 1) % order.length];
  }

  render(snap: WorldSnapshot, signalStates: (readonly SignalState[])[]): void {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const player = snap.trains[snap.playerId];
    const aspect = gl.canvas.width / gl.canvas.height;
    const proj = mat4Perspective((60 * Math.PI) / 180, aspect, 0.5, 4000);
    const { eye, center } = this.cameraPlacement(player);
    const view = mat4LookAt(eye, center, [0, 1, 0]);
    const viewProj = mat4Multiply(proj, view);

    gl.useProgram(this.basicProg);
    gl.uniformMatrix4fv(this.u.uViewProj, false, viewProj);
    gl.uniform3f(this.u.uLightDir, 0.4, 1.0, 0.3);
    gl.uniform3f(this.u.uFogColor, 0.09, 0.11, 0.15);
    gl.uniform1f(this.u.uFogStart, 300);
    gl.uniform1f(this.u.uFogEnd, 1600);

    this.drawMesh(this.ground, mat4Identity());
    this.drawMesh(this.track, mat4Identity());
    this.drawMesh(this.stations, mat4Identity());
    this.drawMesh(this.signals, mat4Identity());

    for (const t of snap.trains) this.drawTrain(t);

    this.drawLamps(viewProj, signalStates);
  }

  private cameraPlacement(player: TrainSnapshot): { eye: Vec3; center: Vec3 } {
    const g = geometryAt(this.line, player.front);
    const heading = g.heading;
    const forward: Vec3 = [Math.cos(heading), 0, Math.sin(heading)];
    const pos: Vec3 = [g.x, g.y, g.z];

    if (this.cameraMode === 'cab') {
      const eye: Vec3 = [
        pos[0] + forward[0] * 2,
        pos[1] + 3.4,
        pos[2] + forward[2] * 2,
      ];
      const center: Vec3 = [
        pos[0] + forward[0] * 120,
        pos[1] + 2.6,
        pos[2] + forward[2] * 120,
      ];
      return { eye, center };
    }
    if (this.cameraMode === 'chase') {
      const eye: Vec3 = [
        pos[0] - forward[0] * 28,
        pos[1] + 12,
        pos[2] - forward[2] * 28,
      ];
      const center: Vec3 = [pos[0], pos[1] + 1.5, pos[2]];
      return { eye, center };
    }
    // orbit
    const a = this.orbitAngle;
    const eye: Vec3 = [
      pos[0] + Math.cos(a) * this.orbitDistance,
      pos[1] + this.orbitDistance * 0.5,
      pos[2] + Math.sin(a) * this.orbitDistance,
    ];
    return { eye, center: [pos[0], pos[1] + 1, pos[2]] };
  }

  private drawTrain(t: TrainSnapshot): void {
    const g = geometryAt(this.line, t.front);
    // Local train mesh runs backward along -x; rotate so -x maps to the rear.
    const heading = g.heading + (t.direction > 0 ? 0 : Math.PI);
    const model = mat4Multiply(
      mat4Translate(g.x, g.y, g.z),
      mat4Multiply(mat4RotateY(heading), mat4Identity()),
    );
    const mesh = this.trainMeshes[t.id % this.trainMeshes.length];
    this.drawMesh(mesh, model);
  }

  private drawMesh(mesh: GpuMesh, model: Float32Array): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.u.uModel, false, model);
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
  }

  private drawLamps(viewProj: Float32Array, signalStates: (readonly SignalState[])[]): void {
    const gl = this.gl;
    // Pack per-instance position + current aspect colour.
    const data: number[] = [];
    let lampIdx = 0;
    for (const trackId of [0, 1] as const) {
      for (const sig of signalStates[trackId]) {
        const lamp = this.lamps[lampIdx++];
        if (!lamp) continue;
        const col = SIGNAL_COLORS[sig.aspect] ?? [0.15, 0.15, 0.15];
        data.push(lamp.x, lamp.y, lamp.z, col[0], col[1], col[2]);
      }
    }
    const instanceCount = lampIdx;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lampMesh.instanceVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(data));

    gl.useProgram(this.lampProg);
    gl.uniformMatrix4fv(this.lampU.uViewProj, false, viewProj);
    gl.uniform1f(this.lampU.uScale, 0.5);
    gl.uniform1f(this.lampU.uIntensity, 1.25);
    gl.bindVertexArray(this.lampMesh.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.lampMesh.vertexCount, gl.UNSIGNED_INT, 0, instanceCount);
  }
}
