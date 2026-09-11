/** Express Request 扩展：setupApp 的 body parser verify 钩子写入原始请求体（回调验签用） */
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}
export {};
