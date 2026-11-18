import type { Line } from '../sim/line';
import type { World } from '../sim/world';
import { clamp } from '../sim/mathutil';
import { curveAt } from '../sim/line';

// ---------- 最小 mat4（列主序） ----------
type Mat4 = Float32Array;

function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function mat4LookAt(eye: [number, number, number], center: [number, number, number], up: [number, number, number]): Mat4 {
  const [ex, ey, ez] = eye;
  let zx = ex - center[0], zy = ey - center[1], zz = ez - center[2];
  let zl = Math.hypot(zx, zy, zz);
  zx /= zl; zy /= zl; zz /= zl;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz);
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
  m[12] = -(xx * ex + xy * ey + xz * ez);
  m[13] = -(yx * ex + yy * ey + yz * ez);
  m[14] = -(zx * ex + zy * ey + zz * ez);
  m[15] = 1;
  return m;
}

function modelMatrix(x: number, y: number, z: number, heading: number, sx: number, sy: number, sz: number): Mat4 {
  const c = Math.cos(heading), s = Math.sin(heading);
  const m = mat4Identity();
  // 旋转 Z 后缩放再平移
  m[0] = c * sx; m[1] = s * sx;
  m[4] = -s * sy; m[5] = c * sy;
  m[10] = sz;
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

// ---------- 着色器 ----------
const VERT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uMVP;
uniform float uPointSize;
void main(){
  gl_Position = uMVP * vec4(aPos, 1.0);
  gl_PointSize = uPointSize;
}
`;

const FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main(){ outColor = uColor; }
`;

const FRAG_POINT = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main(){
  vec2 d = gl_PointCoord - vec2(0.5);
  if(dot(d,d) > 0.25) discard;
  outColor = uColor;
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

interface Sample { x: number; y: number; heading: number; s: number }

export type CameraMode = 'chase' | 'overhead' | 'overview';

export class Renderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private pointProg: WebGLProgram;
  private vbo: WebGLBuffer;
  private lineVbo: WebGLBuffer;
  private samples: Sample[] = [];
  private trackVertices = 0;
  private blockMarkers: { s: number; blockIdx: number }[] = [];
  private platforms: { x: number; y: number; heading: number; len: number }[] = [];
  private mode: CameraMode = 'chase';
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, line: Line) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, vs);
    gl.attachShader(this.prog, fs);
    gl.linkProgram(this.prog);

    const fsp = compile(gl, gl.FRAGMENT_SHADER, FRAG_POINT);
    this.pointProg = gl.createProgram()!;
    gl.attachShader(this.pointProg, vs);
    gl.attachShader(this.pointProg, fsp);
    gl.linkProgram(this.pointProg);

    this.vbo = gl.createBuffer()!;
    this.lineVbo = gl.createBuffer()!;
    this.buildStatic(line);

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.07, 0.09, 0.12, 1);
  }

  toggleMode(): CameraMode {
    const order: CameraMode[] = ['chase', 'overhead', 'overview'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    return this.mode;
  }

  get cameraMode(): CameraMode {
    return this.mode;
  }

  /** 预积分全线平面位置与朝向 */
  private buildStatic(line: Line): void {
    const gl = this.gl;
    const step = 10;
    const n = Math.floor(line.length / step);
    const samples: Sample[] = [];
    let x = 0, y = 0, heading = 0;
    for (let i = 0; i <= n; i++) {
      const s = Math.min(line.length, i * step);
      const r = curveAt(line, s);
      if (i > 0) heading += r !== null ? step / r : 0;
      samples.push({ x, y, heading, s });
      x += Math.sin(heading) * step;
      y += Math.cos(heading) * step;
    }
    this.samples = samples;

    // 轨道：两条钢轨 + 闭塞分区边界线，全部用 GL_LINES
    const verts: number[] = [];
    const gauge = 1.6;
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i], b = samples[i + 1];
      const h = a.heading;
      const ox = Math.cos(h) * gauge, oy = -Math.sin(h) * gauge;
      verts.push(a.x + ox, a.y + oy, 0.02, b.x + ox, b.y + oy, 0.02);
      verts.push(a.x - ox, a.y - oy, 0.02, b.x - ox, b.y - oy, 0.02);
    }
    // 闭塞分区边界
    line.blocks.forEach((blk, idx) => {
      const p = this.poseAt(blk.startS);
      const h = p.heading;
      const w = 2.2;
      verts.push(
        p.x + Math.cos(h) * w, p.y - Math.sin(h) * w, 0.03,
        p.x - Math.cos(h) * w, p.y + Math.sin(h) * w, 0.03,
      );
      this.blockMarkers.push({ s: blk.startS, blockIdx: idx });
    });
    // 站台（中心线处的扁平盒体数据，渲染时动态画）
    for (const stn of line.stations) {
      const p = this.poseAt(stn.stopS);
      this.platforms.push({ x: p.x, y: p.y, heading: p.heading, len: 150 });
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    this.trackVertices = verts.length / 3;
  }

  /** 里程 -> 平面位姿（线性插值采样点） */
  poseAt(s: number): { x: number; y: number; heading: number } {
    const line = this.samples;
    const step = line[1].s - line[0].s;
    const idx = clamp(Math.floor(s / step), 0, line.length - 2);
    const a = line[idx];
    const b = line[idx + 1];
    const t = (s - a.s) / step;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      heading: a.heading + (b.heading - a.heading) * t,
    };
  }

  private useProgram(prog: WebGLProgram): { mvp: WebGLUniformLocation; color: WebGLUniformLocation; pointSize: WebGLUniformLocation } {
    const gl = this.gl;
    gl.useProgram(prog);
    return {
      mvp: gl.getUniformLocation(prog, 'uMVP')!,
      color: gl.getUniformLocation(prog, 'uColor')!,
      pointSize: gl.getUniformLocation(prog, 'uPointSize')!,
    };
  }

  private drawLines(mvp: Mat4, verts: Float32Array, color: [number, number, number, number]): void {
    const gl = this.gl;
    const loc = this.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(loc.mvp, false, mvp);
    gl.uniform4fv(loc.color, color);
    gl.uniform1f(loc.pointSize, 1);
    gl.drawArrays(gl.LINES, 0, verts.length / 3);
  }

  private drawBox(mvp: Mat4, x: number, y: number, z: number, heading: number, sx: number, sy: number, sz: number, color: [number, number, number, number]): void {
    const gl = this.gl;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    // 8 个角点 -> 12 条棱
    const corners = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    const v: number[] = [];
    for (const [i, j] of edges) {
      v.push(...corners[i], ...corners[j]);
    }
    // 平移 + 绕 Z 旋转（缩放已烘焙进角点）
    const model = modelMatrix(x, y, z, heading, 1, 1, 1);
    const world = mat4Multiply(mvp, model);
    const loc = this.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(loc.mvp, false, world);
    gl.uniform4fv(loc.color, color);
    gl.uniform1f(loc.pointSize, 1);
    gl.drawArrays(gl.LINES, 0, v.length / 3);
  }

  private drawPoints(mvp: Mat4, pts: { x: number; y: number; z: number; color: [number, number, number, number] }[], size: number): void {
    const gl = this.gl;
    const loc = this.useProgram(this.pointProg);
    gl.uniformMatrix4fv(loc.mvp, false, mvp);
    gl.uniform1f(loc.pointSize, size);
    // 按颜色分批
    const batches = new Map<string, { x: number; y: number; z: number }[]>();
    for (const p of pts) {
      const key = p.color.join(',');
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key)!.push(p);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    for (const [key, arr] of batches) {
      const color = key.split(',').map(Number) as [number, number, number, number];
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr.flatMap((p) => [p.x, p.y, p.z])), gl.DYNAMIC_DRAW);
      gl.uniform4fv(loc.color, color);
      gl.drawArrays(gl.POINTS, 0, arr.length);
    }
  }

  render(world: World): void {
    const gl = this.gl;
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = canvas.width / canvas.height;
    const proj = mat4Perspective(Math.PI / 4, aspect, 1, 20000);

    // 相机
    const pp = this.poseAt(world.player.s);
    let eye: [number, number, number], center: [number, number, number];
    if (this.mode === 'chase') {
      const back = 60;
      eye = [
        pp.x - Math.sin(pp.heading) * back,
        pp.y - Math.cos(pp.heading) * back,
        38,
      ];
      center = [pp.x, pp.y, 2];
    } else if (this.mode === 'overhead') {
      eye = [pp.x, pp.y, 320];
      center = [pp.x, pp.y, 0];
    } else {
      eye = [0, -200, 2600];
      center = [0, 0, 0];
    }
    const view = mat4LookAt(eye, center, [0, 0, 1]);
    const mvp = mat4Multiply(proj, view);

    // 静态轨道
    {
      const loc = this.useProgram(this.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(loc.mvp, false, mvp);
      gl.uniform4f(loc.color, 0.62, 0.66, 0.72, 1);
      gl.drawArrays(gl.LINES, 0, this.trackVertices);
    }

    // 站台
    for (const pf of this.platforms) {
      this.drawBox(mvp, pf.x, pf.y, 0.6, pf.heading, pf.len, 6, 1.2, [0.35, 0.55, 0.85, 1]);
    }

    // 信号机（分区入口），按当前占用着色
    const pts: { x: number; y: number; z: number; color: [number, number, number, number] }[] = [];
    for (const mk of this.blockMarkers) {
      const p = this.poseAt(mk.s);
      const aspect = world.signals.aspectAtBlock(mk.blockIdx, world.player.id);
      const color: [number, number, number, number] =
        aspect === 'RED' ? [1, 0.18, 0.18, 1]
        : aspect === 'YELLOW' ? [1, 0.82, 0.2, 1]
        : [0.25, 0.9, 0.45, 1];
      pts.push({ x: p.x, y: p.y, z: 1.5, color });
    }
    this.drawPoints(mvp, pts, 9 * Math.min(window.devicePixelRatio, 2));

    // 占用分区高亮（用分区中点短粗线表示）
    const occVerts: number[] = [];
    for (const st of world.signals.states) {
      if (st.occupiedBy === null) continue;
      const blk = world.line.blocks[st.blockId];
      const a = this.poseAt(blk.startS);
      const b = this.poseAt(blk.endS);
      const h = a.heading;
      const ox = Math.cos(h) * 1.9, oy = -Math.sin(h) * 1.9;
      occVerts.push(a.x + ox, a.y + oy, 0.05, b.x + ox, b.y + oy, 0.05);
      occVerts.push(a.x - ox, a.y - oy, 0.05, b.x - ox, b.y - oy, 0.05);
    }
    if (occVerts.length) this.drawLines(mvp, new Float32Array(occVerts), [1, 0.45, 0.2, 1]);

    // 列车
    for (const tr of world.trains) {
      const p = this.poseAt(tr.s);
      const isPlayer = tr.isPlayer;
      const color: [number, number, number, number] = tr.emergencyApplied
        ? [1, 0.2, 0.2, 1]
        : isPlayer
          ? [0.35, 0.85, 1, 1]
          : [0.85, 0.85, 0.9, 1];
      this.drawBox(mvp, p.x, p.y, 1.8, p.heading, 118, 3.2, 3.4, color);
    }

    // 停车标（玩家下一站）
    {
      const stn = world.line.stations[world.player.nextStationIndex];
      const p = this.poseAt(stn.stopS);
      const v = new Float32Array([
        p.x - 2, p.y, 0.05, p.x + 2, p.y, 0.05,
        p.x, p.y - 2, 0.05, p.x, p.y + 2, 0.05,
      ]);
      this.drawLines(mvp, v, [1, 1, 0.4, 1]);
    }
  }
}
