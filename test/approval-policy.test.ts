import { describe, expect, it } from "vitest";
import { evaluateApproval } from "../src/approval-policy.js";

describe("evaluateApproval", () => {
  it("blocks on missing and pending required pieces", () => {
    const result = evaluateApproval(["VIDEO", "COVER"], [
      { piece_type: "VIDEO", version_id: "v1", approved: true },
      { piece_type: "COVER", version_id: null, approved: false },
    ]);

    expect(result).toEqual({
      eligible: false,
      pending_pieces: ["COVER"],
      current_versions: { VIDEO: "v1" },
    });
  });

  it("uses only the campaign's required pieces", () => {
    const result = evaluateApproval(["VIDEO"], [
      { piece_type: "VIDEO", version_id: "video-v1", approved: true },
      { piece_type: "SCRIPT", version_id: null, approved: false },
    ]);

    expect(result.eligible).toBe(true);
    expect(result.pending_pieces).toEqual([]);
    expect(result.current_versions).toEqual({ VIDEO: "video-v1" });
  });

  it("does not reuse approval for a replacement version", () => {
    const result = evaluateApproval(["VIDEO"], [
      { piece_type: "VIDEO", version_id: "video-v2", approved: false },
    ]);

    expect(result.eligible).toBe(false);
    expect(result.pending_pieces).toEqual(["VIDEO"]);
    expect(result.current_versions).toEqual({ VIDEO: "video-v2" });
  });
});
