#!/usr/bin/env node
/** 构建后烙版本（postbuild 钩子，2026-08-27）：把 package.json 的 version + 构建时刻
 * 写入 dist/version.json——版本随产物走：热更/升级包只带 dist 也能对出版本，
 * 不依赖目标机的 package.json（升级包刻意不含它）。 */
const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const out = path.join(process.cwd(), 'dist', 'version.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `${JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`[stamp-version] dist/version.json → ${pkg.version}`);
