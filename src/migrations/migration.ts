import type { DatabaseSync } from "node:sqlite";

export type Migration = Readonly<{
  id: string;
  up(database: DatabaseSync): void;
}>;
