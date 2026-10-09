import { Hono, type Context } from "hono";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { DeliveryService } from "./delivery-service.js";
import { DomainError, PIECE_TYPES, type PieceType } from "./domain.js";

const pieceSchema = z.enum(PIECE_TYPES);
const requirementsSchema = z.array(pieceSchema).min(1).max(PIECE_TYPES.length)
  .refine((pieces) => new Set(pieces).size === pieces.length, "Não repita tipos de peça.");
const campaignSchema = z.object({
  name: z.string().trim().min(1),
  required_pieces: requirementsSchema,
}).strict();
const requirementUpdateSchema = z.object({ required_pieces: requirementsSchema }).strict();
const deliverySchema = z.object({ creator_id: z.string().trim().min(1) }).strict();
const versionSchema = z.union([
  z.object({ content_url: z.string().url().refine((value) => /^https?:\/\//i.test(value), "Use uma URL HTTP ou HTTPS.") }).strict(),
  z.object({ file_name: z.string().trim().min(1) }).strict(),
]);
const commentSchema = z.object({
  second: z.number().finite().min(0),
  text: z.string().trim().min(1),
}).strict();

async function readBody<S extends z.ZodType>(context: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new DomainError(400, "INVALID_JSON", "O corpo da requisição precisa ser JSON válido.");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DomainError(422, "VALIDATION_ERROR", "Os dados da requisição são inválidos.", {
      issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  return result.data;
}

export function createApp(db: DatabaseSync) {
  const app = new Hono();
  const service = new DeliveryService(db);

  app.onError((error, context) => {
    if (error instanceof DomainError) {
      return context.json({ error: error.code, message: error.message, ...error.details }, error.status);
    }
    const message = error instanceof Error ? error.message : "Erro interno.";
    if (message.includes("SQLITE_BUSY") || message.includes("database is locked")) {
      return context.json({ error: "DATABASE_BUSY", message: "O banco está ocupado; tente novamente." }, 503);
    }
    return context.json({ error: "INTERNAL_ERROR", message: "Ocorreu um erro interno." }, 500);
  });

  app.notFound((context) => context.json({ error: "ROUTE_NOT_FOUND", message: "Rota não encontrada." }, 404));

  app.post("/campaigns", async (context) => {
    const body = await readBody(context, campaignSchema);
    return context.json(service.createCampaign(body.name, body.required_pieces as PieceType[]), 201);
  });

  app.get("/campaigns/:id", (context) => context.json(service.getCampaign(context.req.param("id"))));

  app.put("/campaigns/:id/required-pieces", async (context) => {
    const body = await readBody(context, requirementUpdateSchema);
    return context.json(service.setCampaignRequirements(context.req.param("id"), body.required_pieces));
  });

  app.post("/campaigns/:id/deliveries", async (context) => {
    const body = await readBody(context, deliverySchema);
    return context.json(service.createDelivery(context.req.param("id"), body.creator_id), 201);
  });

  app.post("/deliveries/:id/pieces/:type/versions", async (context) => {
    const type = pieceSchema.safeParse(context.req.param("type"));
    if (!type.success) throw new DomainError(422, "VALIDATION_ERROR", "Tipo de peça inválido.");
    const body = await readBody(context, versionSchema);
    const source = "content_url" in body
      ? { source_kind: "URL" as const, content_ref: body.content_url }
      : { source_kind: "FAKE_FILE" as const, content_ref: body.file_name };
    return context.json(service.createVersion(context.req.param("id"), type.data, source), 201);
  });

  app.get("/versions/:id", (context) => context.json({ version: service.getVersion(context.req.param("id")) }));

  app.post("/versions/:id/approve", (context) => context.json({ version: service.approveVersion(context.req.param("id")) }));

  app.post("/versions/:id/comments", async (context) => {
    const body = await readBody(context, commentSchema);
    return context.json(service.createComment(context.req.param("id"), body.second, body.text), 201);
  });

  app.get("/versions/:id/comments", (context) => context.json(service.getComments(context.req.param("id"))));

  app.post("/deliveries/:id/approve", (context) => context.json(service.approveDelivery(context.req.param("id"))));

  app.get("/deliveries/:id", (context) => context.json(service.getDelivery(context.req.param("id"))));

  return app;
}
