import type { PasswordHasher } from "../security/password-hasher.js";
import type { IssuedToken, TokenIssuer } from "../security/token-issuer.js";
import type { UserRepository } from "../users/user-repository.js";
import type { ValidationIssue } from "../register/register-validation.js";
import { validateLoginInput } from "./login-validation.js";

export type LoginResult =
  | { outcome: "authenticated"; token: IssuedToken }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "invalid_credentials" };

export type LoginUser = (input: unknown) => Promise<LoginResult>;

type LoginUserDependencies = {
  userRepository: UserRepository;
  passwordHasher: PasswordHasher;
  tokenIssuer: TokenIssuer;
};

/**
 * Authenticate and issue a JWT.
 * Unknown email and wrong password both map to invalid_credentials (no enumeration).
 */
export function createLoginUser(
  dependencies: LoginUserDependencies,
): LoginUser {
  const { userRepository, passwordHasher, tokenIssuer } = dependencies;

  return async (input: unknown): Promise<LoginResult> => {
    const validation = validateLoginInput(input);

    if (!validation.success) {
      return {
        outcome: "validation_failed",
        issues: validation.issues,
      };
    }

    const { email, password } = validation.value;
    const user = await userRepository.findByEmail(email);

    if (user === undefined) {
      return { outcome: "invalid_credentials" };
    }

    const passwordMatches = await passwordHasher.compare(
      password,
      user.passwordHash,
    );

    if (!passwordMatches) {
      return { outcome: "invalid_credentials" };
    }

    const token = tokenIssuer.issue({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    return { outcome: "authenticated", token };
  };
}
