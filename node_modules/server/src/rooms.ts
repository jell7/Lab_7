import { performance } from 'node:perf_hooks';
import { EventEmitter, on } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import {
  FIXED_DT,
  createWorld,
  createShip,
  stepWorld,
} from 'shared/sim';
import {
  asSeq,
  type EntityId,
  type InputMessage,
  type ServerMessage,
  type SnapshotMessage,
  type WorldState,
} from 'shared/protocol';
import {
  BinarySnapshotCodec,
  JsonSnapshotCodec,
  encodeJson,
  type SnapshotCodec,
} from 'shared/codec';
import { config } from './config.js';
import { JsonLinesTransform } from './log/matchlog.js';
import { netSim } from './netSim.js';
import { createBotPilot, type BotPilot } from './bots.js';

export type RoomLogEvent =
  | { readonly t: number; readonly type: 'join'; readonly name: string; readonly playerId: EntityId }
  | { readonly t: number; readonly type: 'leave'; readonly name: string; readonly playerId: EntityId }
  | { readonly t: number; readonly type: 'chat'; readonly name: string; readonly text: string };

interface RoomEvents {
  log: [RoomLogEvent];
  join: [{ name: string; playerId: EntityId }];
  leave: [{ name: string; playerId: EntityId }];
  chat: [{ name: string; text: string }];
  empty: [];
}

interface ConnectedPlayer {
  readonly id: EntityId;
  readonly name: string;
  codec: SnapshotCodec;
}

const TICK_INTERVAL_MS = 1000 / config.TICK_RATE;
const MAX_TICK_SAMPLES = 300;

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  private readonly players = new Map<WebSocket, ConnectedPlayer>();
  private readonly pendingInputs = new Map<EntityId, InputMessage[]>();
  private readonly bots: BotPilot[] = [];
  world: WorldState;

  private lastTickDurationMs = 0;
  private maxTickDurationMs = 0;
  private readonly tickSamples: number[] = [];
  private nextTickTarget = performance.now() + TICK_INTERVAL_MS;
  private loopTimer: NodeJS.Timeout | null = null;

  constructor(id: string, seed = 1337) {
    super();
    this.id = id;
    this.world = createWorld(seed);
    void this.startLogging();
    this.startLoop();
  }

  private startLoop(): void {
    this.nextTickTarget = performance.now() + TICK_INTERVAL_MS;

    const tick = (): void => {
      const t0 = performance.now();

      const inputsForStep = new Map<EntityId, readonly InputMessage[]>();

      // 1. Збираємо інпути живих гравців
      for (const [playerId, list] of this.pendingInputs.entries()) {
        if (list.length > 0) {
          inputsForStep.set(playerId, list.splice(0, list.length));
        }
      }

      // 2. Збираємо інпути серверних ботів (той самий інтерфейс InputMessage)
      for (let i = 0; i < this.bots.length; i++) {
        const bot = this.bots[i];
        if (bot !== undefined) {
          inputsForStep.set(bot.id, [bot.decide(this.world)]);
        }
      }

      this.world = stepWorld(this.world, inputsForStep, FIXED_DT);

      const t1 = performance.now();
      this.lastTickDurationMs = t1 - t0;
      if (this.lastTickDurationMs > this.maxTickDurationMs) {
        this.maxTickDurationMs = this.lastTickDurationMs;
      }

      this.tickSamples.push(this.lastTickDurationMs);
      if (this.tickSamples.length > MAX_TICK_SAMPLES) {
        this.tickSamples.shift();
      }

      this.broadcastSnapshot();

      this.nextTickTarget += TICK_INTERVAL_MS;
      const delay = Math.max(0, this.nextTickTarget - performance.now());
      this.loopTimer = setTimeout(tick, delay);
    };

    this.loopTimer = setTimeout(tick, TICK_INTERVAL_MS);
  }

  stopLoop(): void {
    if (this.loopTimer !== null) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  spawnBots(count: number): void {
    const newShips = [...this.world.ships];
    for (let i = 0; i < count; i++) {
      const bot = createBotPilot(this.bots.length);
      this.bots.push(bot);
      const spawnX = 200 + ((this.bots.length * 170) % 1200);
      const spawnY = 200 + ((this.bots.length * 130) % 500);
      newShips.push(createShip(bot.id, bot.name, spawnX, spawnY, 0));
    }
    this.world = {
      ...this.world,
      ships: newShips,
    };
  }

  private broadcastSnapshot(): void {
    for (const [socket, player] of this.players.entries()) {
      if (socket.readyState !== 1) continue;
      const ship = this.world.ships.find((s) => s.id === player.id);

      const snapshotMsg: SnapshotMessage = {
        type: 'snapshot',
        tick: this.world.tick,
        serverTime: Date.now(),
        yourId: player.id,
        lastProcessedSeq: ship ? ship.lastProcessedSeq : asSeq(0),
        state: structuredClone(this.world),
      };

      const payload = player.codec.encodeSnapshot(snapshotMsg);

      netSim.sendWithDelay(() => {
        if (socket.readyState === 1) {
          socket.send(payload);
        }
      });
    }
  }

  setPlayerCodec(socket: WebSocket, codecName: 'binary' | 'json'): void {
    const p = this.players.get(socket);
    if (p) {
      p.codec = codecName === 'json' ? JsonSnapshotCodec : BinarySnapshotCodec;
    }
  }

  queueInput(playerId: EntityId, input: InputMessage): void {
    let list = this.pendingInputs.get(playerId);
    if (!list) {
      list = [];
      this.pendingInputs.set(playerId, list);
    }
    list.push(input);
  }

  private async startLogging(): Promise<void> {
    const timestamp = Date.now();
    const logPath = path.join(config.LOG_DIR, `${this.id}-${timestamp}.ndjson`);
    const writeStream = fs.createWriteStream(logPath);

    try {
      await pipeline(
        Readable.from(on(this, 'log')),
        new JsonLinesTransform(),
        writeStream
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Log pipeline error for ${this.id}:`, message);
    }
  }

  join(socket: WebSocket, name: string, playerId: EntityId, codecName: 'binary' | 'json' = 'binary'): void {
    this.players.set(socket, {
      id: playerId,
      name,
      codec: codecName === 'json' ? JsonSnapshotCodec : BinarySnapshotCodec,
    });
    this.pendingInputs.set(playerId, []);

    if (!this.world.ships.some((s) => s.id === playerId)) {
      const spawnX = 350 + (this.world.ships.length * 250) % 900;
      const spawnY = 450;
      this.world = {
        ...this.world,
        ships: [...this.world.ships, createShip(playerId, name, spawnX, spawnY, 0)],
      };
    }

    const roster = [
      ...Array.from(this.players.values()).map((p) => p.name),
      ...this.bots.map((b) => b.name),
    ];
    this.broadcast({ type: 'roster', players: roster });
    this.emit('join', { name, playerId });
    this.emit('log', { t: Date.now(), type: 'join', name, playerId });
  }

  leave(socket: WebSocket, name: string, playerId: EntityId): void {
    this.players.delete(socket);
    this.pendingInputs.delete(playerId);
    this.world = {
      ...this.world,
      ships: this.world.ships.filter((s) => s.id !== playerId),
    };

    const roster = [
      ...Array.from(this.players.values()).map((p) => p.name),
      ...this.bots.map((b) => b.name),
    ];
    this.broadcast({ type: 'roster', players: roster });
    this.emit('leave', { name, playerId });
    this.emit('log', { t: Date.now(), type: 'leave', name, playerId });

    if (this.players.size === 0 && this.bots.length === 0) {
      this.stopLoop();
      this.emit('empty');
    }
  }

  chat(name: string, text: string): void {
    this.broadcast({ type: 'chat', name, text });
    this.emit('chat', { name, text });
    this.emit('log', { t: Date.now(), type: 'chat', name, text });
  }

  broadcast(msg: ServerMessage): void {
    const data = encodeJson(msg);
    for (const socket of this.players.keys()) {
      if (socket.readyState === 1) {
        netSim.sendWithDelay(() => {
          if (socket.readyState === 1) socket.send(data);
        });
      }
    }
  }

  private getTickP99(): number {
    if (this.tickSamples.length === 0) return 0;
    const sorted = [...this.tickSamples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
    return sorted[idx] ?? 0;
  }

  getStats() {
    return {
      roomId: this.id,
      tick: this.world.tick,
      players: this.players.size,
      bots: this.bots.length,
      lastTickDurationMs: Number(this.lastTickDurationMs.toFixed(3)),
      p99TickDurationMs: Number(this.getTickP99().toFixed(3)),
      maxTickDurationMs: Number(this.maxTickDurationMs.toFixed(3)),
    };
  }
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  createRoom(id: string, seed = 1337): Room {
    const room = new Room(id, seed);
    this.rooms.set(id, room);
    room.once('empty', () => {
      this.rooms.delete(id);
    });
    return room;
  }

  getRooms(): Array<{ id: string; name: string; maxPlayers: number }> {
    return Array.from(this.rooms.keys()).map((id) => ({ id, name: id, maxPlayers: 8 }));
  }

  getStats() {
    const mem = process.memoryUsage();
    const elu = performance.eventLoopUtilization();
    return {
      rssMB: Number((mem.rss / 1024 / 1024).toFixed(2)),
      heapUsedMB: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
      elu: Number(elu.utilization.toFixed(3)),
      netSim: netSim.getConfig(),
      rooms: Array.from(this.rooms.values()).map((r) => r.getStats()),
    };
  }
}

export const roomManager = new RoomManager();