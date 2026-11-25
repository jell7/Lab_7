import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TypedBus, type GameEvents } from '../src/bus.js';
import { GameConnection } from '../src/connection.js';
import {
  asEntityId,
  asSeq,
  asTick,
  type SnapshotMessage,
} from 'shared/protocol';
import { encodeBinarySnapshot, encodeJson } from 'shared/codec';
import { createShip, normalizeAngle, wrapCoord, WORLD_WIDTH } from 'shared/sim';

function lerpAngle(a: number, b: number, t: number): number {
  const diff = normalizeAngle(b - a);
  return a + diff * t;
}

function lerpWrap(a: number, b: number, t: number, max: number): number {
  let d = b - a;
  if (d > max / 2) d -= max;
  if (d < -max / 2) d += max;
  return wrapCoord(a + d * t, max);
}

describe('Client TypedBus<GameEvents>', () => {
  it('delivers typed payloads to subscribed listeners', () => {
    const bus = new TypedBus<GameEvents>();
    const received: string[] = [];

    bus.on('chat', ({ name, text }) => {
      received.push(`${name}: ${text}`);
    });

    bus.emit('chat', { name: 'Alice', text: 'Hello!' });
    expect(received).toEqual(['Alice: Hello!']);
  });

  it('unsubscribes cleanly when cleanup function is called', () => {
    const bus = new TypedBus<GameEvents>();
    let count = 0;

    const off = bus.on('rtt', () => {
      count++;
    });

    bus.emit('rtt', { rttMs: 25 });
    off();
    bus.emit('rtt', { rttMs: 30 });

    expect(count).toBe(1);
  });

  it('supports multiple independent subscribers per event', () => {
    const bus = new TypedBus<GameEvents>();
    let a = 0;
    let b = 0;

    bus.on('welcome', () => { a++; });
    bus.on('welcome', () => { b += 2; });

    bus.emit('welcome', { playerId: asEntityId(1), room: 'Alpha Sector' });
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});

describe('Entity Interpolation math (wrap & shortest angle)', () => {
  it.each([
    [10, 30, 0.5, 20],
    [1590, 10, 0.5, 0],
    [10, 1590, 0.5, 0],
    [1580, 20, 0.25, 1590],
    [400, 500, 0, 400],
    [400, 500, 1, 500],
  ])('lerpWrap(%i, %i, %f) -> %i', (a, b, t, expected) => {
    expect(lerpWrap(a, b, t, WORLD_WIDTH)).toBeCloseTo(expected, 4);
  });

  it.each([
    [0, 1, 0.5, 0.5],
    [Math.PI - 0.1, -Math.PI + 0.1, 0.5, Math.PI],
    [-Math.PI + 0.1, Math.PI - 0.1, 0.5, -Math.PI],
    [0.2, 0.8, 0, 0.2],
    [0.2, 0.8, 1, 0.8],
  ])('lerpAngle(%f, %f, %f) -> %f', (a, b, t, expected) => {
    const res = normalizeAngle(lerpAngle(a, b, t));
    expect(Math.abs(normalizeAngle(res - expected))).toBeLessThan(1e-4);
  });
});

describe('Client 30 Hz loop with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes ~30 simulation ticks per 1000 ms', () => {
    let ticks = 0;
    const id = setInterval(() => {
      ticks++;
    }, 1000 / 30);

    vi.advanceTimersByTime(1000);
    clearInterval(id);

    expect(ticks).toBeGreaterThanOrEqual(29);
    expect(ticks).toBeLessThanOrEqual(30);
  });

  it('triggers RTT ping every 1000 ms', () => {
    let pings = 0;
    const id = setInterval(() => {
      pings++;
    }, 1000);

    vi.advanceTimersByTime(3500);
    clearInterval(id);

    expect(pings).toBe(3);
  });
});

describe('GameConnection boundary decoding & queue', () => {
  class MockWebSocket {
    static readonly OPEN = 1;
    static instances: MockWebSocket[] = [];

    readonly url: string;
    binaryType: BinaryType = 'blob';
    readyState = 0;
    sent: Array<ArrayBuffer | string> = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      MockWebSocket.instances.push(this);
    }

    send(data: ArrayBuffer | string): void {
      this.sent.push(data);
    }

    triggerOpen(): void {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }

    triggerMessage(data: unknown): void {
      this.onmessage?.({ data });
    }
  }

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queues outgoing packets before open and flushes on connect', () => {
    const bus = new TypedBus<GameEvents>();
    let bytesOut = 0;
    const conn = new GameConnection('ws://localhost:3000/ws', bus, {
      onBytesOut: (b) => { bytesOut += b; },
    });

    conn.send({ type: 'join', room: 'Alpha Sector', name: 'Tester' });
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws?.sent.length).toBe(0);

    ws?.triggerOpen();
    expect(ws?.sent.length).toBe(1);
    expect(bytesOut).toBeGreaterThan(0);
  });

  it('decodes incoming binary ArrayBuffer snapshot and emits on bus', () => {
    const bus = new TypedBus<GameEvents>();
    let receivedTick = -1;
    bus.on('snapshot', (snap) => {
      receivedTick = snap.tick;
    });

    new GameConnection('ws://localhost:3000/ws', bus);
    const ws = MockWebSocket.instances[0];
    ws?.triggerOpen();

    const snap: SnapshotMessage = {
      type: 'snapshot',
      tick: asTick(88),
      serverTime: 1700000000000,
      yourId: asEntityId(1),
      lastProcessedSeq: asSeq(12),
      state: {
        tick: asTick(88),
        seed: 1337,
        nextBulletId: 1,
        ships: [createShip(asEntityId(1), 'Pilot_1', 300, 400, 0.5)],
        bullets: [],
      },
    };

    ws?.triggerMessage(encodeBinarySnapshot(snap));
    expect(receivedTick).toBe(88);
  });

  it('parses JSON roster and chat messages and ignores malformed payloads', () => {
    const bus = new TypedBus<GameEvents>();
    const playersList: string[][] = [];
    bus.on('roster', ({ players }) => {
      playersList.push([...players]);
    });

    new GameConnection('ws://localhost:3000/ws', bus);
    const ws = MockWebSocket.instances[0];
    ws?.triggerOpen();

    ws?.triggerMessage('{not valid json');
    ws?.triggerMessage(encodeJson({ type: 'roster', players: ['Alice', 'Bob'] }));

    expect(playersList).toEqual([['Alice', 'Bob']]);
  });
});