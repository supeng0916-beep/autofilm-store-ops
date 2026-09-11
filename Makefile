# AutoFilm Demo 开发工具入口（macOS 基准）
# 规范见 docs/standards/STANDARDS.md；环境搭建见 docs/dev-setup.md
SHELL := /bin/bash

.PHONY: setup hooks dev lint test check-db seed seed-p3 migrate openclaw-check reset-test-db

setup: hooks ## 初始化：依赖 + Prisma 客户端 + backend/.env + git 钩子
	cd backend && npm ci
	cd frontend && npm ci
	@[ -f backend/.env ] || cp backend/.env.example backend/.env
	cd backend && npx prisma generate
	@echo "✅ setup 完成"

hooks: ## 启用本地 git 钩子（core.hooksPath）
	git config core.hooksPath .githooks

dev: ## 一键启动前后端（后端 :8000，前端 :5173）
	@echo "启动后端与前端…（Ctrl+C 退出）"
	(cd backend && npm run start:dev) & \
	(cd frontend && npm run dev) & \
	wait

lint: ## 全量代码门禁
	bash scripts/ci.sh

test: ## 前后端测试
	cd backend && npm run test
	cd frontend && npm run test

check-db: ## PostgreSQL + pgvector 连通检查
	cd backend && npm run check-db

seed: ## 种子：5角色+5占位账号（幂等，口令取 WG_SEED_PASSWORD）
	cd backend && npm run seed

seed-p3: ## 种子：P3 合成客资 12 条（幂等，零真实数据，前缀 L-00000000-）
	cd backend && npm run seed:p3

migrate: ## 应用仓库中已经过审查的 Prisma 迁移
	cd backend && npx prisma migrate deploy

openclaw-check: ## OpenClaw 环境检查（P2 前为环境探测）
	bash scripts/openclaw-check.sh

reset-test-db: ## 测试库一键重置（drop+recreate+migrate，种子清零）
	bash scripts/reset-test-db.sh
