export type Flight = {
  id: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureAt: string;
  arrivalAt: string;
  priceInCents: number;
  currency: string;
  availableSeats: number;
  createdAt?: string;
  updatedAt?: string;
}
export type CreateFlightRequest = Omit<Flight, "id">;
