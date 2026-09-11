// 开发治理门禁：只读源码，不连数据库；接入现有 ci.sh。
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// 保留 SQL 标识符/符号，跳过字符串与注释（含 PostgreSQL 嵌套块注释）。
// 只识别显式 DROP INDEX；动态/过程体 SQL 和间接删表仍须迁移审查。
function sqlTokens(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (
      sql[i] === "$" &&
      /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(sql.slice(i))
    ) {
      const delimiter = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i))[0];
      const end = sql.indexOf(delimiter, i + delimiter.length);
      i = end < 0 ? sql.length : end + delimiter.length;
      tokens.push("<string>");
    } else if (sql[i] === "'" || sql[i] === '"') {
      const escaped =
        sql[i] === "'" &&
        /e/i.test(sql[i - 1] ?? "") &&
        (i < 2 || !/[a-z0-9_$]/i.test(sql[i - 2]));
      const quote = sql[i++];
      let value = "";
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i++;
          if (sql[i] !== quote) break;
        }
        value += sql[i++];
      }
      // 字符串占位阻止跨字符串拼出 DROP INDEX；双引号为标识符。
      tokens.push(quote === '"' ? value.toLowerCase() : "<string>");
    } else {
      const word = /^[a-z_][a-z0-9_$]*/i.exec(sql.slice(i));
      if (word) {
        tokens.push(word[0].toLowerCase());
        i += word[0].length;
      } else {
        if (!/\s/.test(sql[i])) tokens.push(sql[i]);
        i++;
      }
    }
  }
  return tokens;
}

function dropsProtectedIndex(sql) {
  const tokens = sqlTokens(sql);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] !== "drop" || tokens[i + 1] !== "index") continue;
    for (let j = i + 2; j < tokens.length && tokens[j] !== ";"; j++) {
      if (tokens[j] === "knowledge_embeddings_embedding_idx") return true;
    }
  }
  return false;
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory()
      ? filesUnder(path)
      : entry.isFile()
        ? [path]
        : [];
  });
}

export function checkGovernance(root, baseline) {
  const errors = [];
  for (const path of filesUnder(resolve(root, "backend/prisma/migrations"))) {
    if (!path.endsWith("/migration.sql")) continue;
    const name = relative(root, path).replaceAll("\\", "/");
    const content = readFileSync(path, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    if (baseline.migrations[name] === hash) continue;
    if (dropsProtectedIndex(content)) {
      errors.push(
        `${name}: 禁止删除 HNSW 索引 knowledge_embeddings_embedding_idx；审查迁移并剔除误生成的 DROP INDEX。`,
      );
    }
  }
  for (const path of filesUnder(resolve(root, "frontend/src"))) {
    if (!path.endsWith(".vue")) continue;
    const name = relative(root, path).replaceAll("\\", "/");
    const content = readFileSync(path, "utf8");
    const lines = content
      ? content.split(/\r?\n/).length - Number(content.endsWith("\n"))
      : 0;
    const limit = baseline.vue[name] ?? 300;
    if (lines > limit) {
      errors.push(
        `${name}: ${lines} 行超过上限 ${limit}；先拆分/复用，禁止调高基线绕过检查。`,
      );
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const baseline = JSON.parse(
    readFileSync(
      new URL("./governance-baseline.json", import.meta.url),
      "utf8",
    ),
  );
  const errors = checkGovernance(root, baseline);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log("开发治理通过：HNSW 迁移保护 / Vue 增长基线");
}
