export interface SpatialBody {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export class SpatialHash<T extends SpatialBody> {
  private readonly cellSize: number;
  private readonly grid = new Map<number, T[]>();
  private readonly bucketPool: T[][] = [];

  constructor(cellSize = 100) {
    this.cellSize = cellSize;
  }

  clear(): void {
    for (const bucket of this.grid.values()) {
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.grid.clear();
  }

  private key(cx: number, cy: number): number {
    return ((cx & 0xffff) << 16) | (cy & 0xffff);
  }

  insert(body: T): void {
    const minCx = Math.floor((body.x - body.radius) / this.cellSize);
    const maxCx = Math.floor((body.x + body.radius) / this.cellSize);
    const minCy = Math.floor((body.y - body.radius) / this.cellSize);
    const maxCy = Math.floor((body.y + body.radius) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const k = this.key(cx, cy);
        let bucket = this.grid.get(k);
        if (!bucket) {
          bucket = this.bucketPool.pop() ?? [];
          this.grid.set(k, bucket);
        }
        bucket.push(body);
      }
    }
  }

  queryNear(x: number, y: number, radius: number, out: T[]): T[] {
    out.length = 0;
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.grid.get(this.key(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const item = bucket[i];
          if (item !== undefined && !out.includes(item)) {
            out.push(item);
          }
        }
      }
    }
    return out;
  }
}