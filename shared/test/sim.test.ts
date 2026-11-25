import { describe, it, expect } from 'vitest';
import {
  FIXED_DT,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  createRng,
  vec2,
  vecAdd,
  vecScale,
  vecLen,
  wrapCoord,
  normalizeAngle,
  checkCircleCollision,
  createShip,
  createWorld,
  integrateShip,
  reconcileShip,
  stepWorld,
} from '../src/sim.js';
import { asEntityId, asSeq, asTick, type InputMessage } from '../src/protocol.js';
import { ObjectPool } from '../src/pool.js';
import { SpatialHash } from '../src/spatialHash.js';

describe('Vector2 & Math helpers', () => {
  it('adds and scales vectors accurately', () => {
    const a = vec2(3, 4);
    const b = vec2(1, -2);
    expect(vecAdd(a, b)).toEqual({ x: 4, y: 2 });
    expect(vecScale(a, 2)).toEqual({ x: 6, y: 8 });
    expect(vecLen(a)).toBe(5);
  });

  it('wraps coordinates across toroidal boundaries', () => {
    expect(wrapCoord(-10, 1600)).toBe(1590);
    expect(wrapCoord(1615, 1600)).toBe(15);
    expect(wrapCoord(0, 900)).toBe(0);
  });

  it('normalizes angles into [-PI, PI]', () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 5);
    expect(normalizeAngle(-Math.PI * 3)).toBeCloseTo(-Math.PI, 5);
  });

  it('produces deterministic sequence from seeded PRNG', () => {
    const r1 = createRng(777);
    const r2 = createRng(777);
    for (let i = 0; i < 20; i++) {
      expect(r1()).toBe(r2());
    }
  });
});

describe('Ship integration & collisions', () => {
  it('accelerates ship forward under thrust', () => {
    const s0 = createShip(asEntityId(1), 'A', 100, 100, 0);
    const s1 = integrateShip(s0, { thrust: 1, turn: 0 }, FIXED_DT);
    expect(s1.vel.x).toBeGreaterThan(0);
    expect(s1.pos.x).toBeGreaterThan(100);
  });

  it('rotates ship under turn input', () => {
    const s0 = createShip(asEntityId(1), 'A', 100, 100, 0);
    const s1 = integrateShip(s0, { thrust: 0, turn: 1 }, FIXED_DT);
    expect(s1.angle).toBeGreaterThan(0);
  });

  it('detects touching, overlapping, and missing circles', () => {
    expect(checkCircleCollision(0, 0, 10, 20, 0, 10)).toBe(true); // touching
    expect(checkCircleCollision(0, 0, 10, 5, 0, 10)).toBe(true);  // overlapping
    expect(checkCircleCollision(0, 0, 10, 25, 0, 10)).toBe(false); // missing
  });

  it('SpatialHash finds nearby colliders and ignores distant ones', () => {
    const sh = new SpatialHash<{ id: number; x: number; y: number; radius: number }>(100);
    sh.insert({ id: 1, x: 50, y: 50, radius: 10 });
    sh.insert({ id: 2, x: 900, y: 800, radius: 10 });
    const near = sh.queryNear(55, 55, 20, []);
    expect(near.map((x) => x.id)).toEqual([1]);
  });

  it('deals damage when bullet hits enemy ship in stepWorld', () => {
    const id1 = asEntityId(1);
    const id2 = asEntityId(2);
    let world = createWorld(1);
    world = {
      ...world,
      ships: [createShip(id1, 'Shooter', 100, 100, 0), createShip(id2, 'Target', 140, 100, 0)],
    };
    const inputs = new Map<typeof id1, readonly InputMessage[]>([
      [id1, [{ type: 'input', seq: asSeq(1), tick: asTick(1), thrust: 0, turn: 0, fire: true }]],
    ]);
    world = stepWorld(world, inputs, FIXED_DT);
    world = stepWorld(world, new Map(), FIXED_DT);
    const target = world.ships.find((s) => s.id === id2);
    expect(target?.hp).toBe(90);
  });
});

describe('Reconciliation & ObjectPool', () => {
  it('reconciles server snapshot and replays unacknowledged inputs', () => {
    const id = asEntityId(1);
    const base = createShip(id, 'Hero', 200, 200, 0);
    const inputs: InputMessage[] = [
      { type: 'input', seq: asSeq(1), tick: asTick(1), thrust: 1, turn: 0, fire: false },
      { type: 'input', seq: asSeq(2), tick: asTick(2), thrust: 1, turn: 0, fire: false },
      { type: 'input', seq: asSeq(3), tick: asTick(3), thrust: 1, turn: 0, fire: false },
    ];
    const afterSeq1 = integrateShip(base, inputs[0]!, FIXED_DT);
    const res = reconcileShip(afterSeq1, inputs, asSeq(1), FIXED_DT);
    expect(res.remainingInputs.length).toBe(2);

    let manual = afterSeq1;
    manual = integrateShip(manual, inputs[1]!, FIXED_DT);
    manual = integrateShip(manual, inputs[2]!, FIXED_DT);
    expect(res.ship.pos.x).toBeCloseTo(manual.pos.x, 6);
  });

  it('ObjectPool reuses released instances without extra allocations', () => {
    const pool = new ObjectPool(2, () => ({ active: false, x: 0 }), (b) => {
      b.active = false;
      b.x = 0;
    });
    const a = pool.acquire();
    a.active = true;
    a.x = 55;
    pool.release(a);
    const b = pool.acquire();
    expect(b).toBe(a);
    expect(b.x).toBe(0);
    expect(pool.totalCreated).toBe(2);
  });
});