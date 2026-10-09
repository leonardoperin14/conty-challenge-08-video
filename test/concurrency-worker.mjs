import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { DeliveryService } from "../dist/delivery-service.js";

const db = new DatabaseSync(workerData.dbPath, { timeout: 5_000 });
const service = new DeliveryService(db);
parentPort.postMessage({ type: "ready" });
Atomics.wait(new Int32Array(workerData.signal), 0, 0, 10_000);

try {
  let value;
  if (workerData.operation === "version") {
    value = service.createVersion(workerData.deliveryId, "VIDEO", {
      source_kind: "FAKE_FILE",
      content_ref: workerData.contentRef,
    });
  } else {
    value = service.approveDelivery(workerData.deliveryId);
  }
  parentPort.postMessage({ type: "result", ok: true, value });
} catch (error) {
  parentPort.postMessage({
    type: "result",
    ok: false,
    code: error?.code ?? "UNEXPECTED_ERROR",
    status: error?.status ?? 500,
    message: error?.message ?? String(error),
  });
} finally {
  db.close();
}
