import type { PieceType } from "./domain.js";

export type CurrentPiece = {
  piece_type: PieceType;
  version_id: string | null;
  approved: boolean;
};

export type ApprovalEvaluation = {
  eligible: boolean;
  pending_pieces: PieceType[];
  current_versions: Partial<Record<PieceType, string>>;
};

/** The single rule for deciding whether the current delivery can be approved. */
export function evaluateApproval(
  requiredPieces: readonly PieceType[],
  currentPieces: readonly CurrentPiece[],
): ApprovalEvaluation {
  const byType = new Map(currentPieces.map((piece) => [piece.piece_type, piece]));
  const pendingPieces: PieceType[] = [];
  const currentVersions: Partial<Record<PieceType, string>> = {};

  for (const pieceType of requiredPieces) {
    const current = byType.get(pieceType);
    if (current?.version_id) currentVersions[pieceType] = current.version_id;
    if (!current?.version_id || !current.approved) pendingPieces.push(pieceType);
  }

  return {
    eligible: pendingPieces.length === 0,
    pending_pieces: pendingPieces,
    current_versions: currentVersions,
  };
}
