import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";

import type {
  IssuedToken,
  TokenIssuer,
  TokenPayload,
} from "./token-issuer.js";

export function createJwtTokenIssuer(deps: {
  secret: string;
  expiresIn: string;
}): TokenIssuer {
  const { secret, expiresIn } = deps;
  const signOptions: SignOptions = {
    expiresIn: expiresIn as NonNullable<SignOptions["expiresIn"]>,
  };

  return {
    issue(payload: TokenPayload): IssuedToken {
      const accessToken = jwt.sign(
        {
          sub: payload.sub,
          email: payload.email,
          role: payload.role,
        },
        secret,
        signOptions,
      );

      return { accessToken, expiresIn };
    },
  };
}
