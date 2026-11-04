/**
 * The SQL twin of isBookable() (BR-FLT-06, Decision 9, ADR-008): a flight
 * is on sale when it is stored `OPEN` and sales have not closed, i.e.
 * `departure_at − 1 h > now`. One fragment for every statement that must
 * agree on it — the two hold statements and the flight search (Decision 17)
 * — so a search never offers a flight the hold would refuse.
 *
 * `departure_at` is compared bare (the interval is on the left with it, not
 * applied to the parameter) to keep the condition exactly as ADR-008 wrote
 * it; the search's index is on the route and departure, not on this.
 * The 1 hour mirrors SALES_CLOSE_BEFORE_DEPARTURE_MS.
 */
export function onSaleSql(flightAlias: string, nowParameter: string): string {
  return `${flightAlias}."status" = 'OPEN'
         AND ${flightAlias}."departure_at" - interval '1 hour' > ${nowParameter}`;
}
