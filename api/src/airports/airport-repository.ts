export type Airport = Readonly<{
  id: string;
  /** IATA, already normalized to upper case (normalizeAirportCode). */
  code: string;
  name: string;
  city: string;
  /** IANA name, stored as given (BR-REF-04). */
  timeZone: string;
  createdAt: string;
}>;

export type CreateAirportResult =
  | { outcome: "created" }
  | { outcome: "duplicate" };

export type AirportPageRequest = {
  limit: number;
  offset: number;
};

/** totalItems is the total in the collection, not the current page. */
export type AirportPage = {
  items: Airport[];
  totalItems: number;
};

/**
 * Application-facing persistence contract for airports (reference data).
 *
 * Does not contain:
 * - Express Request/Response or HTTP status
 * - database driver types (DataSource, TypeORM entities)
 * - snake_case rows
 *
 * `duplicate` means the code is taken (BR-REF-01). The repository compares
 * codes as given, so callers normalize first.
 */
export interface AirportRepository {
  create(airport: Airport): Promise<CreateAirportResult>;

  /** Ordered by code. */
  findPage(request: AirportPageRequest): Promise<AirportPage>;

  /** Exact match on the normalized code (Day 46: resolving a flight's airports). */
  findByCode(code: string): Promise<Airport | undefined>;
}
