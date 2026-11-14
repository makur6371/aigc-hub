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
  vec2 m = (uMouse - 0.5) * 0.22;

  vec3 ro = vec3(0.0, 0.0, -6.4);
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
    vec3 base = mix(vec3(0.43, 0.27, 0.86), vec3(0.73, 0.43, 0.94), n.y*0.5+0.5);
    col = base * (0.25 + diff*0.8) + vec3(0.88, 0.68, 1.0)*fres*0.75;
  }

  col += vec3(0.16, 0.27, 0.85)*glow*0.5 + vec3(0.42, 0.17, 0.79)*glow*0.3;

  float vig = 1.0 - smoothstep(0.3, 1.3, length(uv));
  col *= 0.35 + vig*0.65;

  col = col / (col + 0.6);
  col = pow(col, vec3(0.85));

  float alpha = d < 0.001 ? 1.0 : clamp(glow * 0.7, 0.0, 0.42);
  gl_FragColor = vec4(col, alpha);
}
`

const VERT_SHADER = `
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`

export type ShaderStatus = 'ready' | 'reduced' | 'unavailable'

export function ShaderBackground({ className, playing = true, onStatus }: {
  className?: string
  playing?: boolean
  onStatus?: (status: ShaderStatus) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const setPlayback = useRef<(value: boolean) => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = canvas?.parentElement
    if (!canvas || !stage) return
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false })
    if (!gl) {
      onStatus?.('unavailable')
      return
    }
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) return null
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
      gl.deleteShader(shader)
      return null
    }
    const vert = compile(gl.VERTEX_SHADER, VERT_SHADER)
    const frag = compile(gl.FRAGMENT_SHADER, FRAG_SHADER)
    const program = gl.createProgram()
    const buffer = gl.createBuffer()
    const release = () => {
      if (vert) gl.deleteShader(vert)
      if (frag) gl.deleteShader(frag)
      if (program) gl.deleteProgram(program)
      if (buffer) gl.deleteBuffer(buffer)
    }
    if (vert && frag && program && buffer) {
      gl.attachShader(program, vert)
      gl.attachShader(program, frag)
      gl.linkProgram(program)
    }
    if (!vert || !frag || !program || !buffer || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
      release()
      onStatus?.('unavailable')
      return
    }
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'aPos')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const resolution = gl.getUniformLocation(program, 'uRes')
    const time = gl.getUniformLocation(program, 'uTime')
    const mouse = gl.getUniformLocation(program, 'uMouse')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const pointer = [0.5, 0.5]
    let playingNow = false
    let failed = false
    let raf = 0
    let lastFrame = 0
    let elapsed = 3.5

    const draw = () => {
      if (failed || document.hidden || !canvas.width || !canvas.height) return
      gl.uniform2f(resolution, canvas.width, canvas.height)
      gl.uniform1f(time, elapsed)
      gl.uniform2f(mouse, pointer[0], pointer[1])
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    const animate = (now: number) => {
      if (lastFrame === 0) lastFrame = now - 1000 / 30
      if (now - lastFrame >= 1000 / 32) {
        elapsed += Math.min(now - lastFrame, 50) / 1000
        lastFrame = now
        draw()
      }
      raf = requestAnimationFrame(animate)
    }
    const sync = () => {
      cancelAnimationFrame(raf)
      lastFrame = 0
      if (document.hidden || failed) return
      if (!playingNow || reducedMotion.matches) {
        draw()
        return
      }
      raf = requestAnimationFrame(animate)
    }
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect()
      if (!width || !height || failed) return
      const scale = Math.min(1, 640 / Math.max(width, height))
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      gl.viewport(0, 0, canvas.width, canvas.height)
      draw()
    }
    const onPointer = (event: PointerEvent) => {
      if (!playingNow || reducedMotion.matches || event.pointerType === 'touch') return
      const bounds = stage.getBoundingClientRect()
      pointer[0] = (event.clientX - bounds.left) / bounds.width
      pointer[1] = 1 - (event.clientY - bounds.top) / bounds.height
    }
    const onPreference = () => {
      if (failed) return
      if (reducedMotion.matches) {
        pointer[0] = pointer[1] = 0.5
        draw()
      }
      onStatus?.(reducedMotion.matches ? 'reduced' : 'ready')
      sync()
    }
    const onLost = () => {
      failed = true
      sync()
      onStatus?.('unavailable')
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    stage.addEventListener('pointermove', onPointer)
    reducedMotion.addEventListener('change', onPreference)
    document.addEventListener('visibilitychange', sync)
    canvas.addEventListener('webglcontextlost', onLost)
    onPreference()
    setPlayback.current = (value) => {
      playingNow = value
      sync()
    }
    return () => {
      setPlayback.current = () => {}
      cancelAnimationFrame(raf)
      observer.disconnect()
      stage.removeEventListener('pointermove', onPointer)
      reducedMotion.removeEventListener('change', onPreference)
      document.removeEventListener('visibilitychange', sync)
      canvas.removeEventListener('webglcontextlost', onLost)
      release()
    }
  }, [onStatus])

  useEffect(() => {
    setPlayback.current(playing)
  }, [playing, onStatus])

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}
