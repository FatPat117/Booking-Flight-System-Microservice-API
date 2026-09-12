import bcrypt from "bcrypt";

/** Cost 12: slow enough against brute-force, acceptable for interactive register. */
export const BCRYPT_COST_FACTOR = 12;

export async function hashPasswordWithBcrypt(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}
