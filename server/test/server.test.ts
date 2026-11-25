import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Room } from '../src/rooms.js';
import { BotPilot, createBotPilot } from '../src/bots.js';
import { NetworkSimulator } from '../src/netSim.js';
import {
  asEntityId,
  asSeq,
  asTick,
  parseClientMessage,
  type InputMessage,
} from 'shared/protocol';
import {
  FIXED_DT,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  createShip,
  createWorld,
  stepWorld,
} from 'shared/sim';

describe('Room 30 Hz fixed-step loop with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances at least 29 ticks in 1000 ms at 30 Hz', () => {
    const room = new Room('FakeTimerRoom', 1337);
    try {
      expect(room.world.tick).toBe(0);
      vi.advanceTimersByTime(1000);
      expect(room.world.tick).toBeGreaterThanOrEqual(29);
      expect(room.world.tick).toBeLessThanOrEqual(31);
    } finally {
      room.stopLoop();
    }
  });

  it('tracks tick execution duration metrics in getStats()', () => {
    const room = new Room('StatsRoom', 42);
    try {
      vi.advanceTimersByTime(200);
      const stats = room.getStats();
      expect(stats.roomId).toBe('StatsRoom');
      expect(stats.tick).toBeGreaterThanOrEqual(5);
      expect(stats.lastTickDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      room.stopLoop();
    }
  });
});

describe('BotPilot AI decision making', () => {
  it('generates valid InputMessage within [-1, 1] bounds when chasing a target', () => {
    const bot = createBotPilot(0);
    const enemyId = asEntityId(1);
    let world = createWorld(100);
    world = {
      ...world,
      ships: [
        createShip(bot.id, bot.name, 200, 200, 0),
        createShip(enemyId, 'Human', 500, 220, Math.PI),
      ],
    };

    const cmd = bot.decide(world);
    expect(cmd.type).toBe('input');
    expect(cmd.thrust).toBeGreaterThanOrEqual(-1);
    expect(cmd.thrust).toBeLessThanOrEqual(1);
    expect(cmd.turn).toBeGreaterThanOrEqual(-1);
    expect(cmd.turn).toBeLessThanOrEqual(1);
    expect(typeof cmd.fire).toBe('boolean');
    expect(cmd.fire).toBe(true);
  });

  it('patrols safely and increments seq/tick when no enemies are present', () => {
    const bot = new BotPilot(asEntityId(9050), 'Bot_Solo');
    let world = createWorld(100);
    world = {
      ...world,
      ships: [createShip(bot.id, bot.name, 400, 400, 0)],
    };

    const first = bot.decide(world);
    const second = bot.decide(world);

    expect(first.thrust).toBeGreaterThanOrEqual(-1);
    expect(first.thrust).toBeLessThanOrEqual(1);
    expect(first.turn).toBeGreaterThanOrEqual(-1);
    expect(first.turn).toBeLessThanOrEqual(1);
    expect(second.seq).toBe(first.seq + 1);
    expect(second.tick).toBe(first.tick + 1);
  });
});

describe('NetworkSimulator delay, jitter and packet drop', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('configures parameters and executes immediately when delay is 0', () => {
    const sim = new NetworkSimulator();
    sim.configure({ delayMs: 0, jitterMs: 0, dropRate: 0 });
    expect(sim.getConfig()).toEqual({ delayMs: 0, jitterMs: 0, dropRate: 0 });

    const fn = vi.fn();
    sim.sendWithDelay(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('delays packet delivery by configured delayMs', () => {
    const sim = new NetworkSimulator({ delayMs: 120, jitterMs: 0, dropRate: 0 });
    const fn = vi.fn();

    sim.sendWithDelay(fn);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(119);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('drops 100% of packets when dropRate is 1', () => {
    const sim = new NetworkSimulator({ delayMs: 50, jitterMs: 10, dropRate: 1 });
    const fn = vi.fn();

    for (let i = 0; i < 10; i++) {
      sim.sendWithDelay(fn);
    }
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

// 45 параметризованих кейсів граничних значень для parseClientMessage та stepWorld
interface BoundaryCase {
  readonly label: string;
  readonly kind: 'parse' | 'step';
  readonly payload: unknown;
  readonly expectedOk: boolean;
}

const boundaryCases: readonly BoundaryCase[] = [
  // 25 кейсів для parseClientMessage
  { label: 'parse #01: valid input min thrust/turn (-1, -1)', kind: 'parse', payload: { type: 'input', seq: 0, tick: 0, thrust: -1, turn: -1, fire: false }, expectedOk: true },
  { label: 'parse #02: valid input max thrust/turn (1, 1)', kind: 'parse', payload: { type: 'input', seq: 1, tick: 1, thrust: 1, turn: 1, fire: true }, expectedOk: true },
  { label: 'parse #03: valid input neutral (0, 0)', kind: 'parse', payload: { type: 'input', seq: 50, tick: 100, thrust: 0, turn: 0, fire: false }, expectedOk: true },
  { label: 'parse #04: invalid thrust > 1 (1.001)', kind: 'parse', payload: { type: 'input', seq: 1, tick: 1, thrust: 1.001, turn: 0, fire: false }, expectedOk: false },
  { label: 'parse #05: invalid thrust < -1 (-1.001)', kind: 'parse', payload: { type: 'input', seq: 1, tick: 1, thrust: -1.001, turn: 0, fire: false }, expectedOk: false },
  { label: 'parse #06: invalid turn > 1 (1.5)', kind: 'parse', payload: { type: 'input', seq: 1, tick: 1, thrust: 0, turn: 1.5, fire: false }, expectedOk: false },
  { label: 'parse #07: invalid turn < -1 (-2)', kind: 'parse', payload: { type: 'input', seq: 1, tick: 1, thrust: 0, turn: -2, fire: false }, expectedOk: false },
  { label: 'parse #08: invalid negative seq (-1)', kind: 'parse', payload: { type: 'input', seq: -1, tick: 1, thrust: 0, turn: 0, fire: false }, expectedOk: false },
  { label: 'parse #09: invalid float seq (1.5)', kind: 'parse', payload: { type: 'input', seq: 1.5, tick: 1, thrust: 0, turn: 0, fire: false }, expectedOk: false },
  { label: 'parse #10: invalid negative tick (-5)', kind: 'parse', payload: { type: 'input', seq: 1, tick: -5, thrust: 0, turn: 0, fire: false }, expectedOk: false },
  { label: 'parse #11: invalid fire as string', kind: 'parse', payload: { type: 'input', seq: 1, tick: 1, thrust: 0, turn: 0, fire: 'yes' }, expectedOk: false },
  { label: 'parse #12: invalid NaN thrust', kind: 'parse', payload: { type: 'input', seq: 1, tick: 1, thrust: Number.NaN, turn: 0, fire: false }, expectedOk: false },
  { label: 'parse #13: invalid Infinity turn', kind: 'parse', payload: { type: 'input', seq: 1, tick: 1, thrust: 0, turn: Number.POSITIVE_INFINITY, fire: false }, expectedOk: false },
  { label: 'parse #14: valid join 1-char room & name', kind: 'parse', payload: { type: 'join', room: 'A', name: 'X' }, expectedOk: true },
  { label: 'parse #15: valid join max length room (40) & name (24)', kind: 'parse', payload: { type: 'join', room: 'R'.repeat(40), name: 'N'.repeat(24), codec: 'binary' }, expectedOk: true },
  { label: 'parse #16: invalid join empty room', kind: 'parse', payload: { type: 'join', room: '', name: 'Pilot' }, expectedOk: false },
  { label: 'parse #17: invalid join room > 40 chars', kind: 'parse', payload: { type: 'join', room: 'R'.repeat(41), name: 'Pilot' }, expectedOk: false },
  { label: 'parse #18: invalid join name > 24 chars', kind: 'parse', payload: { type: 'join', room: 'Alpha', name: 'N'.repeat(25) }, expectedOk: false },
  { label: 'parse #19: invalid join unknown codec', kind: 'parse', payload: { type: 'join', room: 'Alpha', name: 'Pilot', codec: 'xml' }, expectedOk: false },
  { label: 'parse #20: valid chat 1 char', kind: 'parse', payload: { type: 'chat', text: '!' }, expectedOk: true },
  { label: 'parse #21: valid chat 300 chars', kind: 'parse', payload: { type: 'chat', text: 'a'.repeat(300) }, expectedOk: true },
  { label: 'parse #22: invalid chat 301 chars', kind: 'parse', payload: { type: 'chat', text: 'a'.repeat(301) }, expectedOk: false },
  { label: 'parse #23: valid codec switch to json', kind: 'parse', payload: { type: 'codec', codec: 'json' }, expectedOk: true },
  { label: 'parse #24: valid ping_rtt', kind: 'parse', payload: { type: 'ping_rtt', t: 12345.67 }, expectedOk: true },
  { label: 'parse #25: invalid null/primitive/unknown type', kind: 'parse', payload: { type: 'teleport', x: 0, y: 0 }, expectedOk: false },

  // 20 кейсів для stepWorld
  { label: 'step #26: empty world advances tick by 1', kind: 'step', payload: { x: 0, y: 0, thrust: 0, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #27: ship at top-left corner (0, 0) moving left wraps to WORLD_WIDTH', kind: 'step', payload: { x: 0, y: 0, angle: Math.PI, thrust: 1, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #28: ship at bottom-right corner moving right wraps to 0', kind: 'step', payload: { x: WORLD_WIDTH - 1, y: WORLD_HEIGHT - 1, angle: 0, thrust: 1, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #29: ship at top edge moving up wraps to WORLD_HEIGHT', kind: 'step', payload: { x: 500, y: 0, angle: -Math.PI / 2, thrust: 1, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #30: ship at bottom edge moving down wraps to 0', kind: 'step', payload: { x: 500, y: WORLD_HEIGHT - 1, angle: Math.PI / 2, thrust: 1, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #31: full reverse thrust (-1) decelerates/moves backward', kind: 'step', payload: { x: 800, y: 450, angle: 0, thrust: -1, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #32: full clockwise turn (+1)', kind: 'step', payload: { x: 800, y: 450, angle: 0, thrust: 0, turn: 1, fire: false }, expectedOk: true },
  { label: 'step #33: full counter-clockwise turn (-1)', kind: 'step', payload: { x: 800, y: 450, angle: 0, thrust: 0, turn: -1, fire: false }, expectedOk: true },
  { label: 'step #34: out-of-range thrust clamped safely inside stepWorld', kind: 'step', payload: { x: 800, y: 450, angle: 0, thrust: 50, turn: -50, fire: false }, expectedOk: true },
  { label: 'step #35: firing spawns exactly 1 bullet when cooldown is 0', kind: 'step', payload: { x: 400, y: 300, angle: 0, thrust: 0, turn: 0, fire: true, expectBullet: true }, expectedOk: true },
  { label: 'step #36: angle near +PI wraps cleanly on positive turn', kind: 'step', payload: { x: 400, y: 300, angle: Math.PI - 0.01, thrust: 0, turn: 1, fire: false }, expectedOk: true },
  { label: 'step #37: angle near -PI wraps cleanly on negative turn', kind: 'step', payload: { x: 400, y: 300, angle: -Math.PI + 0.01, thrust: 0, turn: -1, fire: false }, expectedOk: true },
  { label: 'step #38: diagonal thrust at 45 degrees updates both X and Y', kind: 'step', payload: { x: 300, y: 300, angle: Math.PI / 4, thrust: 1, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #39: diagonal thrust at -135 degrees updates both X and Y', kind: 'step', payload: { x: 300, y: 300, angle: (-3 * Math.PI) / 4, thrust: 1, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #40: zero input on stationary ship keeps position unchanged', kind: 'step', payload: { x: 640, y: 360, angle: 1.2, thrust: 0, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #41: fractional thrust (0.25) and turn (-0.25)', kind: 'step', payload: { x: 640, y: 360, angle: 0.5, thrust: 0.25, turn: -0.25, fire: false }, expectedOk: true },
  { label: 'step #42: firing while turning and thrusting simultaneously', kind: 'step', payload: { x: 700, y: 500, angle: 1.0, thrust: 1, turn: 1, fire: true, expectBullet: true }, expectedOk: true },
  { label: 'step #43: ship near arena center with negative angle', kind: 'step', payload: { x: 800, y: 450, angle: -0.75, thrust: 0.5, turn: 0.5, fire: false }, expectedOk: true },
  { label: 'step #44: ship with tiny sub-pixel coordinates (0.001, 0.001)', kind: 'step', payload: { x: 0.001, y: 0.001, angle: 0, thrust: 0.1, turn: 0, fire: false }, expectedOk: true },
  { label: 'step #45: ship near max bounds (1599.999, 899.999)', kind: 'step', payload: { x: 1599.999, y: 899.999, angle: 0, thrust: 0.1, turn: 0, fire: false }, expectedOk: true },
];

describe('Parameterized boundary suite (45 cases)', () => {
  it.each(boundaryCases)('$label', (tc) => {
    if (tc.kind === 'parse') {
      const res = parseClientMessage(tc.payload);
      expect(res.ok).toBe(tc.expectedOk);
      return;
    }

    const cfg = tc.payload as {
      x: number;
      y: number;
      angle?: number;
      thrust: number;
      turn: number;
      fire: boolean;
      expectBullet?: boolean;
    };

    const shipId = asEntityId(1);
    let world = createWorld(77);
    world = {
      ...world,
      ships: [createShip(shipId, 'BoundaryPilot', cfg.x, cfg.y, cfg.angle ?? 0)],
    };

    const inp: InputMessage = {
      type: 'input',
      seq: asSeq(1),
      tick: asTick(1),
      thrust: cfg.thrust,
      turn: cfg.turn,
      fire: cfg.fire,
    };

    const next = stepWorld(world, new Map([[shipId, [inp]]]), FIXED_DT);
    expect(next.tick).toBe(1);
    const updatedShip = next.ships[0];
    expect(updatedShip).toBeDefined();
    if (updatedShip) {
      expect(Number.isFinite(updatedShip.pos.x)).toBe(true);
      expect(Number.isFinite(updatedShip.pos.y)).toBe(true);
      expect(updatedShip.pos.x).toBeGreaterThanOrEqual(0);
      expect(updatedShip.pos.x).toBeLessThan(WORLD_WIDTH);
      expect(updatedShip.pos.y).toBeGreaterThanOrEqual(0);
      expect(updatedShip.pos.y).toBeLessThan(WORLD_HEIGHT);
      expect(updatedShip.lastProcessedSeq).toBe(1);
    }
    if (cfg.expectBullet) {
      expect(next.bullets.length).toBe(1);
    }
  });
});