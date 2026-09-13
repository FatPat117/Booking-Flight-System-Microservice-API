export type TokenPayload = Readonly<{
  /** userId — JWT standard name for the subject */
  sub: string;
  email: string;
  role: "user" | "admin";
}>;

export type IssuedToken = Readonly<{
  accessToken: string;
  expiresIn: string;
}>;

export type TokenIssuer = Readonly<{
  issue(payload: TokenPayload): IssuedToken;
}>;
