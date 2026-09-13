import type { UserRole } from "../entities/user.entity.js";

export type PublicUser = Readonly<{
  id: string;
  email: string;
  createdAt: string;
}>;

export type UserRecord = Readonly<{
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
}>;

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`Email already registered: ${email}`);
    this.name = "DuplicateEmailError";
  }
}

/**
 * Persistence port for identity users.
 * Must not know Express, HTTP status, or bcrypt.
 */
export type UserRepository = Readonly<{
  findByEmail(email: string): Promise<UserRecord | undefined>;
  create(input: {
    email: string;
    passwordHash: string;
  }): Promise<UserRecord>;
}>;
