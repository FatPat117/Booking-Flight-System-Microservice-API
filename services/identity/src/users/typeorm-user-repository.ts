import type { DataSource, QueryFailedError } from "typeorm";

import { UserEntity } from "../entities/user.entity.js";
import {
  DuplicateEmailError,
  type UserRecord,
  type UserRepository,
} from "./user-repository.js";

function mapUser(entity: UserEntity): UserRecord {
  return {
    id: entity.id,
    email: entity.email,
    passwordHash: entity.passwordHash,
    role: entity.role,
    createdAt: entity.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = (error as QueryFailedError & { code?: string }).code;
  return code === "23505";
}

export function createTypeOrmUserRepository(
  dataSource: DataSource,
): UserRepository {
  const repository = dataSource.getRepository(UserEntity);

  return {
    async findByEmail(email) {
      const entity = await repository.findOneBy({ email });
      return entity ? mapUser(entity) : undefined;
    },

    async create(input) {
      const entity = repository.create({
        email: input.email,
        passwordHash: input.passwordHash,
        role: "user",
      });

      try {
        const saved = await repository.save(entity);
        return mapUser(saved);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateEmailError(input.email);
        }

        throw error;
      }
    },
  };
}
