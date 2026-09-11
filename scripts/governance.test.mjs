import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkGovernance } from "./governance.mjs";

function fixture(t, files, baseline = { vue: {}, migrations: {} }) {
  const root = mkdtempSync(join(tmpdir(), "wg-governance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return checkGovernance(root, baseline);
}
const migration = "backend/prisma/migrations/new/migration.sql";
const vue = "frontend/src/views/Test.vue";
const component = (lines) => "<template />\n".repeat(lines);
const index = "knowledge_embeddings_embedding_idx";

test("保护索引：普通、带 schema、并发、列表及注释分隔的 DROP 均拒绝", (t) => {
  for (const sql of [
    `DROP INDEX "${index}";`,
    `drop index concurrently if exists public."${index}" cascade;`,
    `DROP /* generated */ INDEX other, "public"."${index}";`,
    `DROP INDEX other,\n${index};`,
  ])
    assert.equal(fixture(t, { [migration]: sql }).length, 1, sql);
});

test("注释和字符串中的历史描述、其他索引、创建保护索引均放行", (t) => {
  const sql = `-- DROP INDEX "${index}";\n/* outer /* DROP INDEX ${index}; */ done */
SELECT 'DROP INDEX ${index};';
DROP INDEX another_index;
CREATE INDEX ${index} ON example(id);`;
  assert.deepEqual(fixture(t, { [migration]: sql }), []);
});

test("历史迁移只允许原路径原内容，不允许修改或复制到新路径", (t) => {
  const sql = `DROP INDEX "${index}";`;
  const baseline = {
    vue: {},
    migrations: { [migration]: createHash("sha256").update(sql).digest("hex") },
  };
  assert.deepEqual(fixture(t, { [migration]: sql }, baseline), []);
  assert.equal(fixture(t, { [migration]: sql + "\n" }, baseline).length, 1);
  assert.equal(
    fixture(
      t,
      { ["backend/prisma/migrations/copy/migration.sql"]: sql },
      baseline,
    ).length,
    1,
  );
});

test("新增 Vue：300 行通过，301 行拒绝（包括未跟踪文件）", (t) => {
  assert.deepEqual(fixture(t, { [vue]: component(300) }), []);
  assert.equal(fixture(t, { [vue]: component(301) }).length, 1);
});

test("旧超长 Vue：持平/减少通过，增长拒绝，删除允许", (t) => {
  const baseline = { vue: { [vue]: 400 }, migrations: {} };
  for (const n of [399, 400])
    assert.deepEqual(fixture(t, { [vue]: component(n) }, baseline), []);
  assert.equal(fixture(t, { [vue]: component(401) }, baseline).length, 1);
  assert.deepEqual(fixture(t, {}, baseline), []);
});

test("CRLF 与无末尾换行按物理行计数，非 Vue 文件不受限", (t) => {
  assert.deepEqual(
    fixture(t, {
      [vue]: component(300).trimEnd().replaceAll("\n", "\r\n"),
      "frontend/src/readme.md": component(500),
    }),
    [],
  );
});

test("CLI 从其他工作目录运行，违规退出 1、修复后退出 0", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wg-governance-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "frontend/src"), { recursive: true });
  copyFileSync(
    new URL("./governance.mjs", import.meta.url),
    join(root, "scripts/governance.mjs"),
  );
  writeFileSync(
    join(root, "scripts/governance-baseline.json"),
    JSON.stringify({ vue: {}, migrations: {} }),
  );
  const path = join(root, "frontend/src/New.vue");
  const run = () =>
    spawnSync(process.execPath, [join(root, "scripts/governance.mjs")], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
  writeFileSync(path, component(301));
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /frontend\/src\/New.vue/);
  writeFileSync(path, component(300));
  assert.equal(run().status, 0);
});

test("SQL 转义字符串不遮蔽后续 DROP，dollar 字符串不误报", (t) => {
  const sql = String.raw`SELECT E'it\'s'; DROP INDEX knowledge_embeddings_embedding_idx;`;
  assert.equal(fixture(t, { [migration]: sql }).length, 1);
  for (const literal of [
    "$$DROP INDEX knowledge_embeddings_embedding_idx;$$",
    "$note$DROP INDEX knowledge_embeddings_embedding_idx;$note$",
  ]) {
    assert.deepEqual(fixture(t, { [migration]: `SELECT ${literal};` }), []);
  }
});
