import type { AuditRecorder } from "../audit/audit-recorder.js";
import type { TransactionRunner } from "../transactions/transaction-runner.js";
import { isUuid, type Actor } from "../types.js";
import type { AdminReports, ClassSeats, ManifestPassenger } from "./admin-reports.js";
import { toReportFlightView, type ReportFlightView } from "./report-views.js";

export type FlightManifestView = Readonly<{
  flight: ReportFlightView;
  classes: readonly ClassSeats[];
  heldBookings: number;
  passengers: readonly ManifestPassenger[];
}>;

export type GetFlightManifestResult =
  | Readonly<{ outcome: "found"; manifest: FlightManifestView }>
  | Readonly<{ outcome: "not-found" }>;

export type GetFlightManifest = (flightId: string, actor: Actor) => Promise<GetFlightManifestResult>;

type GetFlightManifestDependencies = {
  adminReports: AdminReports;
  auditRecorder: AuditRecorder;
  transactionRunner: TransactionRunner;
  generateAuditId: () => string;
  getRequestId: () => string | undefined;
  getCurrentTime: () => Date;
};

/**
 * US-ADM-01 (Decision 19): read the manifest in one snapshot, then record
 * who read it. The audit entry gets a transaction of its own because the
 * read is READ ONLY. If recording fails, this throws and the manifest is
 * never returned: no view goes unrecorded. Nothing personal reaches the
 * audit entry, only the count. An unknown flight is not audited.
 */
export function createGetFlightManifest(dependencies: GetFlightManifestDependencies): GetFlightManifest {
  const { adminReports, auditRecorder, transactionRunner, generateAuditId, getRequestId, getCurrentTime } =
    dependencies;

  return async (flightId, actor) => {
    if (!isUuid(flightId)) {
      return { outcome: "not-found" };
    }
    const now = getCurrentTime();
    const manifest = await adminReports.findManifest(flightId, now);
    if (manifest === undefined) {
      return { outcome: "not-found" };
    }

    const requestId = getRequestId();
    await transactionRunner.run(() =>
      auditRecorder.record({
        id: generateAuditId(),
        action: "FLIGHT_MANIFEST_VIEWED",
        actor: { type: "account", id: actor.accountId },
        target: { type: "flight", id: manifest.flight.id },
        ...(requestId === undefined ? {} : { requestId }),
        occurredAt: now.toISOString(),
        metadata: { passengerCount: manifest.passengers.length },
      }),
    );

    return {
      outcome: "found",
      manifest: {
        flight: toReportFlightView(manifest.flight, now),
        classes: manifest.classes,
        heldBookings: manifest.heldBookings,
        passengers: manifest.passengers,
      },
    };
  };
}
