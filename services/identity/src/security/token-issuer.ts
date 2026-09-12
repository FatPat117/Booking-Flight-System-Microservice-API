export type TokenPayload = Readonly<{
  /** userId — JWT standard name for the subject */
  sub: string;
  email: string;
}>;

export type IssuedToken = Readonly<{
  accessToken: string;
  expiresIn: string;
}>;

export type TokenIssuer = Readonly<{
  issue(payload: TokenPayload): IssuedToken;
}>;
