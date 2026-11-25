import WebSocket from 'ws';
import { asSeq, asTick } from 'shared/protocol';
import { encodeBinaryInput } from 'shared/codec';

const SERVER_WS = process.env.WS_URL ?? 'ws://localhost:3000/ws';
const SERVER_HTTP = process.env.HTTP_URL ?? 'http://localhost:3000';
const STAGES = [8, 32, 64, 128];

async function runStage(clientCount: number): Promise<void> {
  const sockets: WebSocket[] = [];
  let rxBytes = 0;

  await Promise.all(
    Array.from({ length: clientCount }, (_, idx) => {
      return new Promise<void>((resolve) => {
        const ws = new WebSocket(SERVER_WS);
        ws.binaryType = 'arraybuffer';
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'join',
              room: `LoadRoom_${clientCount}`,
              name: `BotClient_${idx}`,
              codec: 'binary',
            })
          );
          resolve();
        });
        ws.on('message', (data: Buffer | ArrayBuffer) => {
          rxBytes += data instanceof ArrayBuffer ? data.byteLength : data.length;
        });
        sockets.push(ws);
      });
    })
  );

  let seq = 1;
  const start = performance.now();
  const inputTimer = setInterval(() => {
    const currentSeq = seq++;
    for (let i = 0; i < sockets.length; i++) {
      const ws = sockets[i];
      if (ws && ws.readyState === WebSocket.OPEN) {
        const buf = encodeBinaryInput({
          type: 'input',
          seq: asSeq(currentSeq),
          tick: asTick(currentSeq),
          thrust: 0.8,
          turn: Math.sin(currentSeq * 0.1 + i),
          fire: currentSeq % 10 === 0,
        });
        ws.send(buf);
      }
    }
  }, 1000 / 30);

  await new Promise((r) => setTimeout(r, 4000));
  clearInterval(inputTimer);

  const statsRes = await fetch(`${SERVER_HTTP}/api/stats`);
  const stats = (await statsRes.json()) as {
    rssMB?: number;
    elu?: number;
    rooms: Array<{ roomId: string; lastTickDurationMs: number; maxTickDurationMs: number }>;
  };

  const elapsedSec = (performance.now() - start) / 1000;
  const roomStat = stats.rooms.find((r) => r.roomId === `LoadRoom_${clientCount}`);

  console.log(
    `Clients: ${String(clientCount).padStart(3)} | ` +
      `Tick max: ${String(roomStat?.maxTickDurationMs ?? 0).padStart(6)} ms | ` +
      `ELU: ${String(stats.elu ?? 0).padStart(5)} | ` +
      `RSS: ${String(stats.rssMB ?? 0).padStart(6)} MB | ` +
      `Total RX: ${Math.round(rxBytes / 1024 / elapsedSec)} KB/s`
  );

  for (const ws of sockets) ws.close();
  await new Promise((r) => setTimeout(r, 500));
}

async function main(): Promise<void> {
  console.log('=== SERVER CAPACITY LOAD TEST (budget: 33.3 ms / tick) ===');
  for (const n of STAGES) {
    await runStage(n);
  }
}

void main();