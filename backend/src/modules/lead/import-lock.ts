/** 进程内按 key 串行化的 promise 互斥锁（V1 单机单进程口径）。
 * 用于客资导入去重临界区：同归一化联系方式的并发 confirm/confirmDispatch 按序执行，
 * 关闭「并发同联系方式各建一条主 Lead＋重复 Customer」的竞态（无 DB 级唯一约束时）。
 * 注意：进程内互斥不跨实例——多实例部署需在后续 schema 任务加「归一化联系方式列 + 唯一索引」。 */
export class KeyedLock {
  /** key → 当前队尾 promise（后到者 await 前到者释放） */
  private readonly tails = new Map<string, Promise<void>>();

  /** 以 key 串行执行 fn：同 key 排队，异 key 并行；返回 fn 结果。 */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === gate) this.tails.delete(key);
    }
  }

  /** 批量按 key 串行执行 fn：先按字典序获取所有 key 的锁（一致顺序避免死锁），再执行 fn。 */
  async runAll<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys.filter((k) => k.length > 0))].sort();
    const acquire = (i: number): Promise<T> => {
      if (i >= sorted.length) return fn();
      return this.run(sorted[i], () => acquire(i + 1));
    };
    return acquire(0);
  }
}
