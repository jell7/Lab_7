export class ObjectPool<T> {
  private readonly free: T[] = [];
  private readonly factory: () => T;
  private readonly resetFn: (item: T) => void;
  private createdCount = 0;

  constructor(initialSize: number, factory: () => T, resetFn: (item: T) => void) {
    this.factory = factory;
    this.resetFn = resetFn;
    for (let i = 0; i < initialSize; i++) {
      this.free.push(this.factory());
      this.createdCount++;
    }
  }

  acquire(): T {
    const item = this.free.pop();
    if (item !== undefined) {
      this.resetFn(item);
      return item;
    }
    this.createdCount++;
    const fresh = this.factory();
    this.resetFn(fresh);
    return fresh;
  }

  release(item: T): void {
    this.resetFn(item);
    this.free.push(item);
  }

  get available(): number {
    return this.free.length;
  }

  get totalCreated(): number {
    return this.createdCount;
  }
}