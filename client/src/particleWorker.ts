const MAX_PARTICLES = 1024;
// Кожна частинка: [x, y, vx, vy, life] -> 5 float32
let state = new Float32Array(MAX_PARTICLES * 5);
let cursor = 0;

self.onmessage = (event: MessageEvent<{ type: 'spawn'; x: number; y: number; count: number } | { type: 'step'; dt: number }>) => {
  const msg = event.data;
  if (msg.type === 'spawn') {
    for (let i = 0; i < msg.count; i++) {
      const idx = (cursor % MAX_PARTICLES) * 5;
      cursor++;
      const angle = (i / msg.count) * Math.PI * 2 + (cursor % 7) * 0.1;
      const speed = 60 + (i % 5) * 35;
      state[idx] = msg.x;
      state[idx + 1] = msg.y;
      state[idx + 2] = Math.cos(angle) * speed;
      state[idx + 3] = Math.sin(angle) * speed;
      state[idx + 4] = 0.45;
    }
    return;
  }

  if (msg.type === 'step') {
    const dt = msg.dt;
    const out = new Float32Array(MAX_PARTICLES * 3); // [x, y, alpha]
    let activeCount = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const base = i * 5;
      const life = state[base + 4] ?? 0;
      if (life <= 0) continue;

      const nx = (state[base] ?? 0) + (state[base + 2] ?? 0) * dt;
      const ny = (state[base + 1] ?? 0) + (state[base + 3] ?? 0) * dt;
      const nlife = life - dt;

      state[base] = nx;
      state[base + 1] = ny;
      state[base + 4] = nlife;

      if (nlife > 0) {
        const outBase = activeCount * 3;
        out[outBase] = nx;
        out[outBase + 1] = ny;
        out[outBase + 2] = Math.min(1, nlife / 0.45);
        activeCount++;
      }
    }
    // Zero-copy transfer буфера в головний потік
    self.postMessage({ buffer: out.buffer, count: activeCount }, { transfer: [out.buffer] });
  }
};