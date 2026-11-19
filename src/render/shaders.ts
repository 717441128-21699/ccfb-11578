export const BASIC_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vColor;
out vec3 vNormal;
out vec3 vWorldPos;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorldPos = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  gl_Position = uViewProj * world;
}`;

export const BASIC_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
in vec3 vNormal;
in vec3 vWorldPos;
uniform vec3 uLightDir;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, normalize(uLightDir)), 0.0);
  float ambient = 0.45;
  vec3 lit = vColor * (ambient + 0.6 * diff);
  float dist = length(vWorldPos - vec3(0.0));
  float fog = clamp((dist - uFogStart) / (uFogEnd - uFogStart), 0.0, 0.85);
  outColor = vec4(mix(lit, uFogColor, fog), 1.0);
}`;

export const LAMP_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aInstanceColor;
layout(location=2) in vec3 aInstancePos;
uniform mat4 uViewProj;
uniform float uScale;
out vec3 vLampColor;
void main() {
  vec3 world = aInstancePos + aPos * uScale;
  vLampColor = aInstanceColor;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;
export const LAMP_FRAG = `#version 300 es
precision highp float;
in vec3 vLampColor;
uniform float uIntensity;
out vec4 outColor;
void main() {
  vec3 c = vLampColor * uIntensity;
  outColor = vec4(clamp(c, 0.0, 1.4), 1.0);
}`;
