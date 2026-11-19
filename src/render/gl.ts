/** Thin WebGL2 helpers: shader compilation, VAO/UBO setup. */

export interface GpuMesh {
  vao: WebGLVertexArrayObject;
  indexCount: number;
}

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Failed to allocate shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${log}\n${src}`);
  }
  return sh;
}

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('Failed to allocate program');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    throw new Error(`Program link error: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

export function uploadMesh(
  gl: WebGL2RenderingContext,
  data: { positions: Float32Array; normals: Float32Array; colors: Float32Array; indices: Uint32Array },
): GpuMesh {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Failed to allocate VAO');
  gl.bindVertexArray(vao);

  bindAttrib(gl, data.positions, 0, 3);
  bindAttrib(gl, data.normals, 1, 3);
  bindAttrib(gl, data.colors, 2, 3);

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, indexCount: data.indices.length };
}

function bindAttrib(gl: WebGL2RenderingContext, data: Float32Array, location: number, size: number): void {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

/** Interleaved dynamic instance buffer: vec3 position + vec3 colour per instance. */
export interface InstancedMesh {
  vao: WebGLVertexArrayObject;
  instanceVbo: WebGLBuffer;
  vertexCount: number;
}

/**
 * Builds a VAO containing static unit-cube vertices at location 0, plus a
 * dynamic per-instance buffer (vec3 position @2, vec3 colour @1) updated each
 * frame via updateInstances().
 */
export function createInstancedCube(
  gl: WebGL2RenderingContext,
  cube: { positions: Float32Array; indices: Uint32Array },
  capacity: number,
): InstancedMesh {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Failed to allocate VAO');
  gl.bindVertexArray(vao);

  // Static cube positions.
  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, cube.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  // Static cube index buffer.
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cube.indices, gl.STATIC_DRAW);

  // Dynamic per-instance data: [pos.xyz, color.rgb] stride 24.
  const instanceVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceVbo);
  gl.bufferData(gl.ARRAY_BUFFER, capacity * 6 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribDivisor(2, 1);

  gl.bindVertexArray(null);
  return { vao, instanceVbo, vertexCount: cube.indices.length };
}

export function uniformLoc(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string): WebGLUniformLocation | null {
  return gl.getUniformLocation(prog, name);
}
