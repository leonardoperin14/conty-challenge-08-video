import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db.js";
import { DeliveryService } from "../src/delivery-service.js";

const directories: string[] = [];
const workerFile = fileURLToPath(new URL("./concurrency-worker.mjs", import.meta.url));

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setupApprovedDelivery() {
  const directory = mkdtempSync(join(tmpdir(), "conty-review-"));
  directories.push(directory);
  const dbPath = join(directory, "challenge.sqlite");
  const db = initializeDatabase(dbPath);
  const service = new DeliveryService(db);
  const campaign = service.createCampaign("Concurrent", ["VIDEO"]);
  const delivery = service.createDelivery(campaign.id, "creator");
  const v1 = service.createVersion(delivery.id, "VIDEO", { source_kind: "FAKE_FILE", content_ref: "v1.mp4" });
  service.approveVersion(v1.id);
  service.approveDelivery(delivery.id);
  db.close();
  return { directory, dbPath, deliveryId: delivery.id };
}

async function runWorkers(
  dbPath: string,
  deliveryId: string,
  operations: Array<{ operation: "version" | "approve"; contentRef?: string }>,
) {
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = operations.map((operation) => new Worker(workerFile, {
    workerData: { ...operation, dbPath, deliveryId, signal },
  }));
  const results = workers.map((worker) => new Promise<Record<string, any>>((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.type === "result") resolve(message);
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Worker exited with ${code}`));
    });
  }));
  await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker did not reach concurrency barrier")), 10_000);
    worker.on("message", (message) => {
      if (message.type === "ready") {
        clearTimeout(timeout);
        resolve();
      }
    });
    worker.on("error", reject);
  })));
  Atomics.store(new Int32Array(signal), 0, 1);
  Atomics.notify(new Int32Array(signal), 0, workers.length);
  const output = await Promise.all(results);
  await Promise.all(workers.map((worker) => worker.terminate()));
  return output;
}

describe("SQLite concurrency", () => {
  it("does not approve a delivery against a version created concurrently", async () => {
    const { dbPath, deliveryId } = setupApprovedDelivery();
    const results = await runWorkers(dbPath, deliveryId, [
      { operation: "version", contentRef: "v2.mp4" },
      { operation: "approve" },
    ]);

    expect(results.some((result) => result.ok)).toBe(true);
    const db = initializeDatabase(dbPath);
    const delivery = new DeliveryService(db).getDelivery(deliveryId);
    expect(delivery.status).toBe("IN_PRODUCTION");
    expect(delivery.pending_pieces).toEqual(["VIDEO"]);
    expect(delivery.approval_history).toHaveLength(1);
    expect(delivery.approval_history[0].invalidated_at).toBeTruthy();
    db.close();
  });

  it("assigns unique sequential versions to concurrent submissions", async () => {
    const { dbPath, deliveryId } = setupApprovedDelivery();
    const results = await runWorkers(dbPath, deliveryId, [
      { operation: "version", contentRef: "v2.mp4" },
      { operation: "version", contentRef: "v3.mp4" },
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.value.version_number).sort()).toEqual([2, 3]);

    const db = initializeDatabase(dbPath);
    const delivery = new DeliveryService(db).getDelivery(deliveryId);
    expect(delivery.pieces[0].versions.map((version: { version_number: number }) => version.version_number)).toEqual([1, 2, 3]);
    db.close();
  });
});
