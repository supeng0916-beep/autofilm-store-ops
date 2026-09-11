/** hello skill echo 回退（P3-00）：无模型环境的通道验证兜底。
 * 输入 stdin JSON = backend 提交载荷（taskId/taskType/context）；
 * 输出严格 JSON `{"greeting":"…","model":"echo"}`（单行，无多余字段）。
 * 约束：不调模型、不回调、不签名、不访问任何工具/客户数据/凭证。 */
interface EchoPayload {
  taskId?: string;
  taskType?: string;
  context?: { name?: unknown };
}

function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const raw = Buffer.from(await readStdin()).toString('utf8').trim();
  let payload: EchoPayload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw) as EchoPayload;
    } catch {
      // 非 JSON 输入按缺省处理，不回退失败（echo 模式尽力而为）
    }
  }
  const name =
    typeof payload.context?.name === 'string' && payload.context.name.length > 0
      ? payload.context.name
      : 'AutoFilm Demo';
  process.stdout.write(JSON.stringify({ greeting: `你好，${name}`, model: 'echo' }));
}

main().catch((err) => {
  console.error('hello echo 失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
