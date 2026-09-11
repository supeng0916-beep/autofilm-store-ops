import { BossAggregator } from './boss.aggregator';
import { ManagerAggregator } from './manager.aggregator';

/** 角色聚合器注册清单（agent.module providers 用） */
export const aggregators = [BossAggregator, ManagerAggregator];
