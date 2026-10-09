import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { initializeDatabase } from "../src/db.js";

let db: ReturnType<typeof initializeDatabase>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = initializeDatabase();
  app = createApp(db);
});

afterEach(() => db.close());

async function request(method: string, path: string, body?: unknown) {
  const response = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function createCampaign(requiredPieces: string[] = ["VIDEO"]) {
  const { response, body } = await request("POST", "/campaigns", {
    name: "Campanha de lançamento",
    required_pieces: requiredPieces,
  });
  expect(response.status).toBe(201);
  return body as { id: string; required_pieces: string[] };
}

async function createDelivery(campaignId: string) {
  const { response, body } = await request("POST", `/campaigns/${campaignId}/deliveries`, {
    creator_id: "creator-1",
  });
  expect(response.status).toBe(201);
  return body as { id: string };
}

async function createVersion(deliveryId: string, pieceType: string, source: Record<string, string> = { file_name: "v1.mp4" }) {
  const { response, body } = await request("POST", `/deliveries/${deliveryId}/pieces/${pieceType}/versions`, source);
  expect(response.status).toBe(201);
  return body as { id: string; version_number: number; status: string };
}

async function approveVersion(versionId: string) {
  const { response, body } = await request("POST", `/versions/${versionId}/approve`);
  expect(response.status).toBe(200);
  return body.version as { id: string; approved_at: string };
}

describe("campaigns and delivery approvals", () => {
  it("returns a clear conflict when required pieces are missing or pending", async () => {
    const campaign = await createCampaign(["SCRIPT", "VIDEO", "COVER", "CAPTION"]);
    const delivery = await createDelivery(campaign.id);

    const absent = await request("POST", `/deliveries/${delivery.id}/approve`);
    expect(absent.response.status).toBe(409);
    expect(absent.body).toMatchObject({
      error: "REQUIRED_PIECES_NOT_APPROVED",
      pending_pieces: ["CAPTION", "COVER", "SCRIPT", "VIDEO"],
    });

    const video = await createVersion(delivery.id, "VIDEO");
    const pending = await request("POST", `/deliveries/${delivery.id}/approve`);
    expect(pending.response.status).toBe(409);
    expect(pending.body.pending_pieces).toEqual(["CAPTION", "COVER", "SCRIPT", "VIDEO"]);

    await approveVersion(video.id);
    const stillPending = await request("POST", `/deliveries/${delivery.id}/approve`);
    expect(stillPending.response.status).toBe(409);
    expect(stillPending.body.pending_pieces).toEqual(["CAPTION", "COVER", "SCRIPT"]);
  });

  it("approves a video-only campaign without requiring a script", async () => {
    const campaign = await createCampaign(["VIDEO"]);
    const delivery = await createDelivery(campaign.id);
    const video = await createVersion(delivery.id, "VIDEO", { content_url: "https://example.test/video.mp4" });
    await approveVersion(video.id);

    const approval = await request("POST", `/deliveries/${delivery.id}/approve`);
    expect(approval.response.status).toBe(200);
    expect(approval.body.status).toBe("APPROVED");
    expect(approval.body.approval.id).toBeTruthy();

    const state = await request("GET", `/deliveries/${delivery.id}`);
    expect(state.body.status).toBe("APPROVED");
    expect(state.body.required_pieces).toEqual(["VIDEO"]);
    expect(state.body.pieces).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_approval_versions").get()).toEqual({ count: 1 });
  });

  it("requires and snapshots every piece configured on the campaign", async () => {
    const campaign = await createCampaign(["SCRIPT", "VIDEO", "COVER", "CAPTION"]);
    const delivery = await createDelivery(campaign.id);
    const versionIds: string[] = [];

    for (const pieceType of campaign.required_pieces) {
      const version = await createVersion(delivery.id, pieceType, { file_name: `${pieceType.toLowerCase()}-v1` });
      versionIds.push(version.id);
      const blocked = await request("POST", `/deliveries/${delivery.id}/approve`);
      if (pieceType !== campaign.required_pieces.at(-1)) {
        expect(blocked.response.status).toBe(409);
      }
      await approveVersion(version.id);
    }

    const approved = await request("POST", `/deliveries/${delivery.id}/approve`);
    expect(approved.response.status).toBe(200);
    const state = await request("GET", `/deliveries/${delivery.id}`);
    expect(state.body.status).toBe("APPROVED");
    expect(state.body.approval_history[0].versions).toHaveLength(4);
    expect(state.body.approval_history[0].versions.map((item: { version_id: string }) => item.version_id).sort())
      .toEqual(versionIds.sort());
  });

  it("keeps history and invalidates final approval when a required piece gets a new version", async () => {
    const campaign = await createCampaign(["VIDEO"]);
    const delivery = await createDelivery(campaign.id);
    const v1 = await createVersion(delivery.id, "VIDEO");
    const approvedV1 = await approveVersion(v1.id);
    const firstApproval = await request("POST", `/deliveries/${delivery.id}/approve`);
    expect(firstApproval.body.status).toBe("APPROVED");

    const v2 = await createVersion(delivery.id, "VIDEO", { file_name: "v2.mov" });
    const inProduction = await request("GET", `/deliveries/${delivery.id}`);
    expect(inProduction.body.status).toBe("IN_PRODUCTION");
    expect(inProduction.body.pending_pieces).toEqual(["VIDEO"]);
    expect(inProduction.body.pieces[0].versions.map((version: { id: string }) => version.id)).toEqual([v1.id, v2.id]);
    expect(inProduction.body.pieces[0].versions[0]).toMatchObject({
      id: v1.id,
      version_number: 1,
      status: "APPROVED",
      is_current: false,
    });
    expect(inProduction.body.pieces[0].versions[1]).toMatchObject({
      id: v2.id,
      version_number: 2,
      status: "SUBMITTED",
      is_current: true,
    });
    expect(inProduction.body.approval_history).toHaveLength(1);
    expect(inProduction.body.approval_history[0].invalidated_at).toBeTruthy();
    expect(inProduction.body.approval_history[0].versions).toEqual([{ piece_type: "VIDEO", version_id: v1.id }]);

    const oldApproval = await request("POST", `/versions/${v1.id}/approve`);
    expect(oldApproval.response.status).toBe(409);
    expect((await request("GET", `/versions/${v1.id}`)).body.version.approved_at).toBe(approvedV1.approved_at);

    await approveVersion(v2.id);
    const ready = await request("GET", `/deliveries/${delivery.id}`);
    expect(ready.body.status).toBe("READY_FOR_APPROVAL");

    const secondApproval = await request("POST", `/deliveries/${delivery.id}/approve`);
    expect(secondApproval.response.status).toBe(200);
    expect(secondApproval.body.status).toBe("APPROVED");
    const finalState = await request("GET", `/deliveries/${delivery.id}`);
    expect(finalState.body.approval_history).toHaveLength(2);
    expect(finalState.body.approval_history[1].versions).toEqual([{ piece_type: "VIDEO", version_id: v2.id }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_approvals WHERE invalidated_at IS NULL").get())
      .toEqual({ count: 1 });
  });

  it("does not let an optional piece invalidate an approved delivery", async () => {
    const campaign = await createCampaign(["VIDEO"]);
    const delivery = await createDelivery(campaign.id);
    const video = await createVersion(delivery.id, "VIDEO");
    await approveVersion(video.id);
    await request("POST", `/deliveries/${delivery.id}/approve`);

    await createVersion(delivery.id, "SCRIPT", { file_name: "optional-script.txt" });
    const state = await request("GET", `/deliveries/${delivery.id}`);
    expect(state.body.status).toBe("APPROVED");
    expect(state.body.pieces.find((piece: { piece_type: string }) => piece.piece_type === "SCRIPT").required).toBe(false);
  });

  it("lets requirements change before a delivery and locks them afterward", async () => {
    const campaign = await createCampaign(["VIDEO"]);
    const changed = await request("PUT", `/campaigns/${campaign.id}/required-pieces`, { required_pieces: ["COVER"] });
    expect(changed.response.status).toBe(200);
    expect(changed.body.required_pieces).toEqual(["COVER"]);
    await createDelivery(campaign.id);
    const locked = await request("PUT", `/campaigns/${campaign.id}/required-pieces`, { required_pieces: ["VIDEO"] });
    expect(locked.response.status).toBe(409);
    expect(locked.body.error).toBe("CAMPAIGN_REQUIREMENTS_LOCKED");
  });

  it("rejects duplicate requirements, empty campaigns, and unknown resources", async () => {
    const duplicate = await request("POST", "/campaigns", { name: "x", required_pieces: ["VIDEO", "VIDEO"] });
    expect(duplicate.response.status).toBe(422);
    const empty = await request("POST", "/campaigns", { name: "x", required_pieces: [] });
    expect(empty.response.status).toBe(422);
    const missing = await request("GET", "/deliveries/not-found");
    expect(missing.response.status).toBe(404);
  });
});

describe("video comments", () => {
  it("keeps a comment on its exact video version and timestamp", async () => {
    const campaign = await createCampaign(["VIDEO"]);
    const delivery = await createDelivery(campaign.id);
    const v1 = await createVersion(delivery.id, "VIDEO");
    const created = await request("POST", `/versions/${v1.id}/comments`, { second: 15, text: "Ajustar o corte." });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ version_id: v1.id, second: 15, text: "Ajustar o corte." });
    expect(created.body.id).toBeTruthy();
    expect(created.body.created_at).toBeTruthy();

    const v2 = await createVersion(delivery.id, "VIDEO", { file_name: "v2.mp4" });
    const commentsV1 = await request("GET", `/versions/${v1.id}/comments`);
    const commentsV2 = await request("GET", `/versions/${v2.id}/comments`);
    expect(commentsV1.body.comments).toHaveLength(1);
    expect(commentsV1.body.comments[0]).toMatchObject({ id: created.body.id, version_id: v1.id, second: 15 });
    expect(commentsV2.body.comments).toEqual([]);
  });

  it("rejects invalid seconds, empty text, and comments on non-video pieces", async () => {
    const campaign = await createCampaign(["VIDEO"]);
    const delivery = await createDelivery(campaign.id);
    const video = await createVersion(delivery.id, "VIDEO");
    const negative = await request("POST", `/versions/${video.id}/comments`, { second: -1, text: "x" });
    expect(negative.response.status).toBe(422);
    const empty = await request("POST", `/versions/${video.id}/comments`, { second: 0, text: "   " });
    expect(empty.response.status).toBe(422);

    const script = await createVersion(delivery.id, "SCRIPT", { file_name: "script.txt" });
    const notVideo = await request("POST", `/versions/${script.id}/comments`, { second: 0, text: "x" });
    expect(notVideo.response.status).toBe(422);
    const invalidUrl = await request("POST", `/deliveries/${delivery.id}/pieces/VIDEO/versions`, { content_url: "ftp://example.test/a.mp4" });
    expect(invalidUrl.response.status).toBe(422);
  });
});
