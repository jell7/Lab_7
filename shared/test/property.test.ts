import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  encodeBinaryInput,
  decodeBinaryInput,
  encodeBinarySnapshot,
  decodeBinarySnapshot,
} from '../src/codec.js';
import {
  asEntityId,
  asSeq,
  asTick,
  parseClientMessage,
  type InputMessage,
  type SnapshotMessage,
} from '../src/protocol.js';
import {
  FIXED_DT,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  createShip,
  createWorld,
  stepWorld,
} from '../src/sim.js';

describe('Property-based tests (fast-check)', () => {
  it('Property 1: Binary Input round-trip preserves fields within Int8 quantization', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        fc.boolean(),
        (seq, tick, tInt, turnInt, fire) => {
          const msg: InputMessage = {
            type: 'input',
            seq: asSeq(seq),
            tick: asTick(tick),
            thrust: tInt / 100,
            turn: turnInt / 100,
            fire,
          };
          const buf = encodeBinaryInput(msg);
          expect(buf.byteLength).toBe(13);
          const decoded = decodeBinaryInput(buf);
          expect(decoded.ok).toBe(true);
          if (decoded.ok) {
            expect(decoded.data).toEqual(msg);
          }
        }
      )
    );
  });

  it('Property 2: Binary Snapshot byte length matches protocol spec and round-trips angle within Int16 precision', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.float({ min: 0, max: Math.fround(WORLD_WIDTH), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 0, max: Math.fround(WORLD_HEIGHT), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: Math.fround(-Math.PI), max: Math.fround(Math.PI), noNaN: true, noDefaultInfinity: true }),
        (tick, x, y, angle) => {
          const snap: SnapshotMessage = {
            type: 'snapshot',
            tick: asTick(tick),
            serverTime: 1700000000000,
            yourId: asEntityId(1),
            lastProcessedSeq: asSeq(10),
            state: {
              tick: asTick(tick),
              seed: 1337,
              nextBulletId: 1,
              ships: [createShip(asEntityId(1), 'P1', x, y, angle)],
              bullets: [],
            },
          };
          const buf = encodeBinarySnapshot(snap);
          expect(buf.byteLength).toBe(21 + 1 * 20 + 2);
          const decoded = decodeBinarySnapshot(buf);
          expect(decoded.ok).toBe(true);
          if (decoded.ok) {
            const s = decoded.data.state.ships[0];
            expect(s).toBeDefined();
            if (s) {
              expect(Math.abs(s.angle - angle)).toBeLessThan(0.002);
            }
          }
        }
      )
    );
  });

  it('Property 3: Arbitrary corrupted binary buffers never throw unhandled exceptions', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 256 }), (bytes) => {
        const resIn = decodeBinaryInput(bytes);
        const resSnap = decodeBinarySnapshot(bytes);
        expect(typeof resIn.ok).toBe('boolean');
        expect(typeof resSnap.ok).toBe('boolean');
      })
    );
  });

  it('Property 4: Ship always remains inside arena bounds over random input sequences', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            thrust: fc.double({ min: -1, max: 1, noNaN: true }),
            turn: fc.double({ min: -1, max: 1, noNaN: true }),
            fire: fc.boolean(),
          }),
          { minLength: 10, maxLength: 120 }
        ),
        (actions) => {
          const id = asEntityId(1);
          let world = createWorld(99);
          world = { ...world, ships: [createShip(id, 'Runner', 400, 400, 0)] };
          for (let i = 0; i < actions.length; i++) {
            const act = actions[i]!;
            const inp: InputMessage = {
              type: 'input',
              seq: asSeq(i + 1),
              tick: asTick(i + 1),
              ...act,
            };
            world = stepWorld(world, new Map([[id, [inp]]]), FIXED_DT);
            const ship = world.ships[0]!;
            expect(ship.pos.x).toBeGreaterThanOrEqual(0);
            expect(ship.pos.x).toBeLessThan(WORLD_WIDTH);
            expect(ship.pos.y).toBeGreaterThanOrEqual(0);
            expect(ship.pos.y).toBeLessThan(WORLD_HEIGHT);
          }
        }
      )
    );
  });

  it('Property 5: parseClientMessage accepts valid chat messages and rejects invalid mutations', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (text) => {
        const valid = parseClientMessage({ type: 'chat', text });
        expect(valid.ok).toBe(true);

        const invalid = parseClientMessage({ type: 'chat', text: '' });
        expect(invalid.ok).toBe(false);
      })
    );
  });
});