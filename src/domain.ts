export const PIECE_TYPES = ["SCRIPT", "VIDEO", "COVER", "CAPTION"] as const;
export type PieceType = (typeof PIECE_TYPES)[number];

export type VersionSource = {
  source_kind: "URL" | "FAKE_FILE";
  content_ref: string;
};

export class DomainError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 422 | 503,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
