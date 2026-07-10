import express from "express";
import type { Flight } from "./types.ts";

const app = express()
const PORT = 3000

const flights: Flight[] = [];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req,res) => {
  res.status(200).json({ message: "OK" });
})


app.get('/api/flights/:id', (req,res) => {
  const {id:flightId} = req.params;
  const flight = flights.find((f) => f.id === flightId);
  if (!flight) {
    return res.status(404).json({ message: "Flight not found" });
  }
  res.status(200).json(flight);  
});

app.get("/api/flights", (_req, res) => {
  res.status(200).json(flights);
});

app.post("/api/flights", (req,res) => {
  const { flightNumber, origin, destination, departureAt, arrivalAt, priceInCents, currency, availableSeats } = req.body;
  const flight: Flight = { id: crypto.randomUUID(), flightNumber, origin, destination, departureAt, arrivalAt, priceInCents, currency, availableSeats };
  flights.push(flight);
  res.header("Location", `/api/flights/${flight.id}`);
  res.status(201).json(flight);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});