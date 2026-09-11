/** JWT 载荷与会话用户（type 区分 access/refresh，防令牌混用） */
export interface JwtPayload {
  sub: string;
  username: string;
  type: 'access' | 'refresh';
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}
