import { randomUUID } from 'node:crypto';

/** 测试用户名唯一化（P1 遗留 T8-1 回收）：前缀 + 随机段，避免跨测试撞名。
 * username 列唯一约束下，撞名会导致并发/重复跑测试时建号失败。 */
export function uniqueUsername(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
