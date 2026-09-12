import {
  DuplicateEmailError,
  type PublicUser,
  type UserRepository,
} from "../users/user-repository.js";
import type { ValidationIssue } from "./register-validation.js";
import { validateRegisterInput } from "./register-validation.js";

export type RegisterResult =
  | { outcome: "created"; user: PublicUser }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "duplicate_email" };

export type RegisterUser = (input: unknown) => Promise<RegisterResult>;

export type HashPassword = (password: string) => Promise<string>;

type RegisterUserDependencies = {
  userRepository: UserRepository;
  hashPassword: HashPassword;
};

/**
 * Register a user with a hashed password.
 * Never returns passwordHash — PublicUser only.
 */
export function createRegisterUser(
  dependencies: RegisterUserDependencies,
): RegisterUser {
  const { userRepository, hashPassword } = dependencies;

  return async (input: unknown): Promise<RegisterResult> => {
    const validation = validateRegisterInput(input);

    if (!validation.success) {
      return {
        outcome: "validation_failed",
        issues: validation.issues,
      };
    }

    const { email, password } = validation.value;

    const existing = await userRepository.findByEmail(email);
    if (existing !== undefined) {
      return { outcome: "duplicate_email" };
    }

    const passwordHash = await hashPassword(password);

    try {
      const created = await userRepository.create({ email, passwordHash });

      return {
        outcome: "created",
        user: {
          id: created.id,
          email: created.email,
          createdAt: created.createdAt.toISOString(),
        },
      };
    } catch (error) {
      // UNIQUE constraint race: two concurrent registers for the same email.
      if (error instanceof DuplicateEmailError) {
        return { outcome: "duplicate_email" };
      }

      throw error;
    }
  };
}
