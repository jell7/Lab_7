import {
  asEntityId,
  asSeq,
  asTick,
  type EntityId,
  type InputMessage,
  type WorldState,
} from 'shared/protocol';
import { normalizeAngle, WORLD_HEIGHT, WORLD_WIDTH } from 'shared/sim';

export class BotPilot {
  readonly id: EntityId;
  readonly name: string;
  private seq = 1;
  private tick = 1;

  constructor(id: EntityId, name: string) {
    this.id = id;
    this.name = name;
  }

  decide(world: WorldState): InputMessage {
    const self = world.ships.find((s) => s.id === this.id);
    const target = world.ships.find((s) => s.id !== this.id);

    let thrust = 0.65;
    let turn = 0;
    let fire = false;

    if (self && target) {
      let dx = target.pos.x - self.pos.x;
      let dy = target.pos.y - self.pos.y;
      if (dx > WORLD_WIDTH / 2) dx -= WORLD_WIDTH;
      if (dx < -WORLD_WIDTH / 2) dx += WORLD_WIDTH;
      if (dy > WORLD_HEIGHT / 2) dy -= WORLD_HEIGHT;
      if (dy < -WORLD_HEIGHT / 2) dy += WORLD_HEIGHT;

      const desiredAngle = Math.atan2(dy, dx);
      const diff = normalizeAngle(desiredAngle - self.angle);
      turn = Math.max(-1, Math.min(1, diff * 2.2));
      const dist = Math.hypot(dx, dy);
      thrust = dist > 180 ? 0.85 : 0.25;
      fire = Math.abs(diff) < 0.22 && dist < 650;
    } else {
      turn = 0.4;
    }

    return {
      type: 'input',
      seq: asSeq(this.seq++),
      tick: asTick(this.tick++),
      thrust,
      turn,
      fire,
    };
  }
}

let nextBotNum = 9000;
export function createBotPilot(index: number): BotPilot {
  const id = asEntityId(nextBotNum++);
  return new BotPilot(id, `Bot_${index + 1}`);
}