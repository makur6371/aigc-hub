'use client'

import { useEffect, useRef } from 'react'

const FRAG_SHADER = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;

mat2 rot(float a){ float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }

float sdTorus(vec3 p, vec2 t){
  vec2 q = vec2(length(p.xz)-t.x, p.y);
  return length(q)-t.y;
}

float smin(float a, float b, float k){
  float h = clamp(0.5+0.5*(b-a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0-h);
}

float map(vec3 p){
  float t = uTime*0.25;
  vec3 p1 = p;
  p1.xy = rot(t)*p1.xy;
  float d1 = sdTorus(p1, vec2(1.3, 0.32));
  vec3 p2 = p;
  p2.yz = rot(t*1.1 + 1.2)*p2.yz;
  float d2 = sdTorus(p2, vec2(1.3, 0.32));
  vec3 p3 = p;
  p3.xz = rot(t*0.9 + 2.4)*p3.xz;
  float d3 = sdTorus(p3, vec2(1.3, 0.32));
  return smin(smin(d1, d2, 0.5), d3, 0.5);
}

vec3 calcNormal(vec3 p){
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(
    map(p+e.xyy)-map(p-e.xyy),
    map(p+e.yxy)-map(p-e.yxy),
    map(p+e.yyx)-map(p-e.yyx)
  ));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;
  vec2 m = (uMouse - 0.5) * 0.6;

  vec3 ro = vec3(0.0, 0.0, -4.2);
  vec3 rd = normalize(vec3(uv + m, 1.6));

  float t = 0.0;
  float d = 0.0;
  float glow = 0.0;
  for(int i=0;i<80;i++){
    vec3 p = ro + rd*t;
    d = map(p);
    if(d < 0.001) break;
    if(t > 12.0) break;
    glow += 0.012 / (1.0 + d*d*2.0);
    t += d;
  }

  vec3 col = vec3(0.0);
  if(d < 0.001){
    vec3 p = ro + rd*t;
    vec3 n = calcNormal(p);
    vec3 ld = normalize(vec3(0.6, 0.8, -0.5));
    float diff = max(dot(n, ld), 0.0);
    float fres = pow(1.0 - max(dot(-rd, n), 0.0), 2.5);
    vec3 base = mix(vec3(0.18, 0.27, 0.85), vec3(0.42, 0.17, 0.79), n.y*0.5+0.5);
    col = base * (0.25 + diff*0.8) + vec3(0.13, 0.83, 0.93)*fres*0.6;
  }

  col += vec3(0.16, 0.27, 0.85)*glow*0.5 + vec3(0.42, 0.17, 0.79)*glow*0.3;

  float vig = smoothstep(1.3, 0.3, length(uv));
  col *= 0.35 + vig*0.65;

  col = col / (col + 0.6);
  col = pow(col, vec3(0.85));

  gl_FragColor = vec4(col, 1.0);
}
`

const VERT_SHADER = `
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`

/**
 * 全屏 WebGL 着色器背景：固定定位、铺满视口，位于所有内容之下。
 * 三环 raymarch 的光晕会透过右侧半透明面板隐约可见。
 */
export function ShaderBackground({ onUnsupported }: { onUnsupported?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mouseRef = useRef<[number, number]>([0.5, 0.5])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false })
    // Gate 1: WebGL unavailable → degrade to minimal.
    if (!gl) {
      onUnsupported?.()
      return
    }

    // 编译 shader,带错误检查(失败→降级)
    const compile = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('[ShaderBackground] shader compile failed:', gl.getShaderInfoLog(s))
        return null
      }
      return s
    }
    const vs = compile(gl.VERTEX_SHADER, VERT_SHADER)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SHADER)
    if (!vs || !fs) {
      onUnsupported?.()
      return
    }

    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[ShaderBackground] program link failed:', gl.getProgramInfoLog(prog))
      onUnsupported?.()
      return
    }
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(prog, 'uRes')
    const uTime = gl.getUniformLocation(prog, 'uTime')
    const uMouse = gl.getUniformLocation(prog, 'uMouse')

    let resize: (() => void) | null = null
    let onMove: ((e: MouseEvent) => void) | null = null
    let onContextLost: ((e: Event) => void) | null = null
    let raf = 0
    let disposed = false

    const dispose = () => {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(raf)
      if (resize) window.removeEventListener('resize', resize)
      if (onMove) window.removeEventListener('mousemove', onMove)
      if (onContextLost) canvas.removeEventListener('webglcontextlost', onContextLost)
    }

    resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
      const w = window.innerWidth * dpr
      const h = window.innerHeight * dpr
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()
    window.addEventListener('resize', resize)

    onMove = (e: MouseEvent) => {
      mouseRef.current = [e.clientX / window.innerWidth, 1 - e.clientY / window.innerHeight]
    }
    window.addEventListener('mousemove', onMove)

    // Gate 2: context lost → 清理监听器 + 降级
    onContextLost = (e: Event) => {
      e.preventDefault()
      dispose()
      onUnsupported?.()
    }
    canvas.addEventListener('webglcontextlost', onContextLost)

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = performance.now()

    // Gate 3: framerate probe — 采样前 2s,平均 FPS < 30 → 降级
    let frames = 0
    const probeStart = performance.now()
    const PROBE_MS = 2000
    const MIN_FPS = 30
    let probed = false

    const render = () => {
      if (disposed) return
      const now = performance.now()
      const time = reduced ? 0 : (now - start) / 1000
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, time)
      gl.uniform2f(uMouse, mouseRef.current[0], mouseRef.current[1])
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      if (!reduced && !probed) {
        frames++
        if (now - probeStart >= PROBE_MS) {
          probed = true
          const fps = (frames * 1000) / (now - probeStart)
          if (fps < MIN_FPS) {
            dispose()
            onUnsupported?.()
            return
          }
        }
      }
      raf = requestAnimationFrame(render)
    }
    render()

    return dispose
  }, [onUnsupported])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 h-full w-full"
      style={{ zIndex: 0 }}
    />
  )
}
