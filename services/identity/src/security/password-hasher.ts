import bcrypt from "bcrypt";

/** Cost 12: slow enough against brute-force, acceptable for interactive register. */
export const BCRYPT_COST_FACTOR = 12;

export type PasswordHasher = Readonly<{
  hash(password: string): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
}>;

export function createBcryptPasswordHasher(): PasswordHasher {
  return {
    async hash(password) {
      return bcrypt.hash(password, BCRYPT_COST_FACTOR);
    },

    async compare(password, passwordHash) {
      return bcrypt.compare(password, passwordHash);
    },
  };
}
