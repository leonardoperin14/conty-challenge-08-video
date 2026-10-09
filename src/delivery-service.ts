import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { evaluateApproval, type CurrentPiece } from "./approval-policy.js";
import { DomainError, PIECE_TYPES, type PieceType, type VersionSource } from "./domain.js";
import { inTransaction } from "./db.js";

type CampaignRow = { id: string; name: string; created_at: string };
type DeliveryRow = { id: string; campaign_id: string; creator_id: string; created_at: string };
type RequiredRow = { piece_type: PieceType };
type CurrentRow = {
  piece_type: PieceType;
  version_id: string | null;
  approved_at: string | null;
};
type VersionRow = {
  id: string;
  delivery_id: string;
  piece_type: PieceType;
  version_number: number;
  source_kind: "URL" | "FAKE_FILE";
  content_ref: string;
  created_at: string;
  approved_at: string | null;
};

function requiredPieceTypes(values: readonly string[]): PieceType[] {
  return values as PieceType[];
}

function mapVersion(row: VersionRow, isCurrent?: boolean) {
  return {
    id: row.id,
    delivery_id: row.delivery_id,
    piece_type: row.piece_type,
    version_number: row.version_number,
    source_kind: row.source_kind,
    content_ref: row.content_ref,
    created_at: row.created_at,
    status: row.approved_at ? "APPROVED" : "SUBMITTED",
    approved_at: row.approved_at,
    ...(isCurrent === undefined ? {} : { is_current: isCurrent }),
  };
}

function missing(code: string, entity: string): never {
  throw new DomainError(404, code, `${entity} não encontrado.`);
}

export class DeliveryService {
  constructor(private readonly db: DatabaseSync) {}

  createCampaign(name: string, requiredPieces: readonly PieceType[]) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    inTransaction(this.db, () => {
      this.db.prepare("INSERT INTO campaigns (id, name, created_at) VALUES (?, ?, ?)")
        .run(id, name, createdAt);
      const insert = this.db.prepare(
        "INSERT INTO campaign_required_pieces (campaign_id, piece_type) VALUES (?, ?)",
      );
      for (const pieceType of requiredPieces) insert.run(id, pieceType);
    });
    return { id, name, required_pieces: [...requiredPieces], created_at: createdAt };
  }

  getCampaign(id: string) {
    const campaign = this.db.prepare("SELECT id, name, created_at FROM campaigns WHERE id = ?")
      .get(id) as CampaignRow | undefined;
    if (!campaign) missing("CAMPAIGN_NOT_FOUND", "Campanha");
    const required = this.db.prepare(
      "SELECT piece_type FROM campaign_required_pieces WHERE campaign_id = ? ORDER BY piece_type",
    ).all(id) as RequiredRow[];
    return { ...campaign, required_pieces: required.map((row) => row.piece_type) };
  }

  setCampaignRequirements(id: string, requiredPieces: readonly PieceType[]) {
    return inTransaction(this.db, () => {
      const campaign = this.db.prepare("SELECT id, name, created_at FROM campaigns WHERE id = ?")
        .get(id) as CampaignRow | undefined;
      if (!campaign) missing("CAMPAIGN_NOT_FOUND", "Campanha");
      const existing = this.db.prepare("SELECT 1 AS found FROM deliveries WHERE campaign_id = ? LIMIT 1")
        .get(id);
      if (existing) {
        throw new DomainError(
          409,
          "CAMPAIGN_REQUIREMENTS_LOCKED",
          "As peças exigidas não podem mudar depois da primeira entrega.",
        );
      }
      this.db.prepare("DELETE FROM campaign_required_pieces WHERE campaign_id = ?").run(id);
      const insert = this.db.prepare(
        "INSERT INTO campaign_required_pieces (campaign_id, piece_type) VALUES (?, ?)",
      );
      for (const pieceType of requiredPieces) insert.run(id, pieceType);
      return { ...campaign, required_pieces: [...requiredPieces] };
    });
  }

  createDelivery(campaignId: string, creatorId: string) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    return inTransaction(this.db, () => {
      const campaign = this.db.prepare("SELECT id FROM campaigns WHERE id = ?").get(campaignId);
      if (!campaign) missing("CAMPAIGN_NOT_FOUND", "Campanha");
      const requirements = this.db.prepare(
        "SELECT COUNT(*) AS count FROM campaign_required_pieces WHERE campaign_id = ?",
      ).get(campaignId) as { count: number };
      if (requirements.count === 0) {
        throw new DomainError(409, "CAMPAIGN_HAS_NO_REQUIRED_PIECES", "A campanha deve exigir pelo menos uma peça.");
      }
      this.db.prepare(
        "INSERT INTO deliveries (id, campaign_id, creator_id, created_at) VALUES (?, ?, ?, ?)",
      ).run(id, campaignId, creatorId, createdAt);
      return { id, campaign_id: campaignId, creator_id: creatorId, created_at: createdAt, status: "IN_PRODUCTION" };
    });
  }

  createVersion(deliveryId: string, pieceType: PieceType, source: VersionSource) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    return inTransaction(this.db, () => {
      const delivery = this.db.prepare("SELECT id, campaign_id FROM deliveries WHERE id = ?")
        .get(deliveryId) as Pick<DeliveryRow, "id" | "campaign_id"> | undefined;
      if (!delivery) missing("DELIVERY_NOT_FOUND", "Entrega");
      const latest = this.db.prepare(
        "SELECT MAX(version_number) AS version_number FROM piece_versions WHERE delivery_id = ? AND piece_type = ?",
      ).get(deliveryId, pieceType) as { version_number: number | null };
      const versionNumber = (latest.version_number ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO piece_versions
          (id, delivery_id, piece_type, version_number, source_kind, content_ref, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, deliveryId, pieceType, versionNumber, source.source_kind, source.content_ref, createdAt);

      const required = this.db.prepare(
        "SELECT 1 AS required FROM campaign_required_pieces WHERE campaign_id = ? AND piece_type = ?",
      ).get(delivery.campaign_id, pieceType);
      if (required) {
        this.db.prepare(
          "UPDATE delivery_approvals SET invalidated_at = ? WHERE delivery_id = ? AND invalidated_at IS NULL",
        ).run(createdAt, deliveryId);
      }
      const row = this.db.prepare("SELECT * FROM piece_versions WHERE id = ?").get(id) as VersionRow;
      return mapVersion(row, true);
    });
  }

  approveVersion(versionId: string) {
    return inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM piece_versions WHERE id = ?").get(versionId) as VersionRow | undefined;
      if (!row) missing("VERSION_NOT_FOUND", "Versão");
      const current = this.db.prepare(
        "SELECT id FROM piece_versions WHERE delivery_id = ? AND piece_type = ? ORDER BY version_number DESC LIMIT 1",
      ).get(row.delivery_id, row.piece_type) as { id: string } | undefined;
      if (current?.id !== row.id) {
        throw new DomainError(409, "VERSION_NOT_CURRENT", "Somente a versão atual da peça pode ser aprovada.");
      }
      if (!row.approved_at) {
        this.db.prepare("UPDATE piece_versions SET approved_at = ? WHERE id = ?")
          .run(new Date().toISOString(), row.id);
      }
      const updated = this.db.prepare("SELECT * FROM piece_versions WHERE id = ?").get(row.id) as VersionRow;
      return mapVersion(updated, true);
    });
  }

  getVersion(versionId: string) {
    const row = this.db.prepare("SELECT * FROM piece_versions WHERE id = ?").get(versionId) as VersionRow | undefined;
    if (!row) missing("VERSION_NOT_FOUND", "Versão");
    const latest = this.db.prepare(
      "SELECT id FROM piece_versions WHERE delivery_id = ? AND piece_type = ? ORDER BY version_number DESC LIMIT 1",
    ).get(row.delivery_id, row.piece_type) as { id: string };
    return mapVersion(row, latest.id === row.id);
  }

  createComment(versionId: string, second: number, text: string) {
    return inTransaction(this.db, () => {
      const version = this.db.prepare("SELECT id, piece_type FROM piece_versions WHERE id = ?")
        .get(versionId) as { id: string; piece_type: PieceType } | undefined;
      if (!version) missing("VERSION_NOT_FOUND", "Versão");
      if (version.piece_type !== "VIDEO") {
        throw new DomainError(422, "COMMENTS_REQUIRE_VIDEO", "Comentários com marcação de tempo pertencem somente a versões de vídeo.");
      }
      const comment = {
        id: randomUUID(),
        version_id: versionId,
        second,
        text,
        created_at: new Date().toISOString(),
      };
      this.db.prepare(
        "INSERT INTO video_comments (id, version_id, second, text, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(comment.id, comment.version_id, comment.second, comment.text, comment.created_at);
      return comment;
    });
  }

  getComments(versionId: string) {
    const version = this.db.prepare("SELECT piece_type FROM piece_versions WHERE id = ?")
      .get(versionId) as { piece_type: PieceType } | undefined;
    if (!version) missing("VERSION_NOT_FOUND", "Versão");
    if (version.piece_type !== "VIDEO") {
      throw new DomainError(422, "COMMENTS_REQUIRE_VIDEO", "Comentários com marcação de tempo pertencem somente a versões de vídeo.");
    }
    const comments = this.db.prepare(
      "SELECT id, version_id, second, text, created_at FROM video_comments WHERE version_id = ? ORDER BY second, created_at, id",
    ).all(versionId);
    return { version_id: versionId, comments };
  }

  approveDelivery(deliveryId: string) {
    return inTransaction(this.db, () => {
      const context = this.loadApprovalContext(deliveryId);
      const evaluation = evaluateApproval(context.requiredPieces, context.currentPieces);
      if (!evaluation.eligible) {
        throw new DomainError(
          409,
          "REQUIRED_PIECES_NOT_APPROVED",
          "A entrega possui peças obrigatórias pendentes.",
          { pending_pieces: evaluation.pending_pieces },
        );
      }

      const active = this.db.prepare(
        "SELECT id, created_at FROM delivery_approvals WHERE delivery_id = ? AND invalidated_at IS NULL",
      ).get(deliveryId) as { id: string; created_at: string } | undefined;
      if (active && this.snapshotMatches(active.id, evaluation.current_versions)) {
        return { delivery_id: deliveryId, status: "APPROVED", approval: { id: active.id, created_at: active.created_at } };
      }
      if (active) {
        this.db.prepare("UPDATE delivery_approvals SET invalidated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), active.id);
      }

      const approval = { id: randomUUID(), created_at: new Date().toISOString() };
      this.db.prepare(
        "INSERT INTO delivery_approvals (id, delivery_id, created_at, invalidated_at) VALUES (?, ?, ?, NULL)",
      ).run(approval.id, deliveryId, approval.created_at);
      const insertVersion = this.db.prepare(
        "INSERT INTO delivery_approval_versions (approval_id, delivery_id, piece_type, version_id) VALUES (?, ?, ?, ?)",
      );
      for (const pieceType of context.requiredPieces) {
        const versionId = evaluation.current_versions[pieceType];
        if (!versionId) throw new Error(`Missing approved version for ${pieceType}`);
        insertVersion.run(approval.id, deliveryId, pieceType, versionId);
      }
      return { delivery_id: deliveryId, status: "APPROVED", approval };
    });
  }

  getDelivery(deliveryId: string) {
    return inTransaction(this.db, () => {
      const delivery = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(deliveryId) as DeliveryRow | undefined;
      if (!delivery) missing("DELIVERY_NOT_FOUND", "Entrega");
      const context = this.loadApprovalContext(deliveryId);
      const evaluation = evaluateApproval(context.requiredPieces, context.currentPieces);
      const active = this.db.prepare(
        "SELECT id, created_at FROM delivery_approvals WHERE delivery_id = ? AND invalidated_at IS NULL",
      ).get(deliveryId) as { id: string; created_at: string } | undefined;
      const approved = Boolean(active && this.snapshotMatches(active.id, evaluation.current_versions));
      const status = evaluation.pending_pieces.length
        ? "IN_PRODUCTION"
        : approved
          ? "APPROVED"
          : "READY_FOR_APPROVAL";

      const rows = this.db.prepare(
        "SELECT * FROM piece_versions WHERE delivery_id = ? ORDER BY piece_type, version_number",
      ).all(deliveryId) as VersionRow[];
      const latestByType = new Map(
        context.currentPieces.filter((piece) => piece.version_id).map((piece) => [piece.piece_type, piece.version_id]),
      );
      const pieces = PIECE_TYPES.filter((pieceType) => rows.some((row) => row.piece_type === pieceType)).map((pieceType) => ({
        piece_type: pieceType,
        required: context.requiredPieces.includes(pieceType),
        current_version_id: latestByType.get(pieceType) ?? null,
        versions: rows.filter((row) => row.piece_type === pieceType)
          .map((row) => mapVersion(row, latestByType.get(pieceType) === row.id)),
      }));

      const approvalRows = this.db.prepare(
        "SELECT id, created_at, invalidated_at FROM delivery_approvals WHERE delivery_id = ? ORDER BY created_at",
      ).all(deliveryId) as Array<{ id: string; created_at: string; invalidated_at: string | null }>;
      const approvalHistory = approvalRows.map((approval) => ({
        ...approval,
        versions: this.db.prepare(
          "SELECT piece_type, version_id FROM delivery_approval_versions WHERE approval_id = ? ORDER BY piece_type",
        ).all(approval.id),
      }));

      return {
        id: delivery.id,
        campaign_id: delivery.campaign_id,
        creator_id: delivery.creator_id,
        created_at: delivery.created_at,
        status,
        required_pieces: context.requiredPieces,
        pending_pieces: evaluation.pending_pieces,
        pieces,
        approval_history: approvalHistory,
      };
    }, "DEFERRED");
  }

  private loadApprovalContext(deliveryId: string) {
    const delivery = this.db.prepare("SELECT id, campaign_id FROM deliveries WHERE id = ?")
      .get(deliveryId) as Pick<DeliveryRow, "id" | "campaign_id"> | undefined;
    if (!delivery) missing("DELIVERY_NOT_FOUND", "Entrega");

    const requiredRows = this.db.prepare(
      "SELECT piece_type FROM campaign_required_pieces WHERE campaign_id = ? ORDER BY piece_type",
    ).all(delivery.campaign_id) as RequiredRow[];
    const requiredPieces = requiredPieceTypes(requiredRows.map((row) => row.piece_type));
    const currentRows = requiredPieces.length
      ? this.db.prepare(`
          SELECT r.piece_type, v.id AS version_id, v.approved_at
          FROM campaign_required_pieces r
          LEFT JOIN piece_versions v
            ON v.delivery_id = ? AND v.piece_type = r.piece_type
           AND v.version_number = (
             SELECT MAX(v2.version_number) FROM piece_versions v2
             WHERE v2.delivery_id = ? AND v2.piece_type = r.piece_type
           )
          WHERE r.campaign_id = ? ORDER BY r.piece_type
        `).all(deliveryId, deliveryId, delivery.campaign_id) as CurrentRow[]
      : [];
    const currentPieces: CurrentPiece[] = currentRows.map((row) => ({
      piece_type: row.piece_type,
      version_id: row.version_id,
      approved: Boolean(row.approved_at),
    }));
    return { requiredPieces, currentPieces };
  }

  private snapshotMatches(approvalId: string, currentVersions: Partial<Record<PieceType, string>>) {
    const rows = this.db.prepare(
      "SELECT piece_type, version_id FROM delivery_approval_versions WHERE approval_id = ? ORDER BY piece_type",
    ).all(approvalId) as Array<{ piece_type: PieceType; version_id: string }>;
    const saved = new Map(rows.map((row) => [row.piece_type, row.version_id]));
    const keys = Object.keys(currentVersions) as PieceType[];
    return saved.size === keys.length && keys.every((pieceType) => saved.get(pieceType) === currentVersions[pieceType]);
  }
}
