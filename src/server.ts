import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app.js";
import { initializeDatabase } from "./db.js";

const databasePath = process.env.DATABASE_PATH ?? "./data/conty.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });
const db = initializeDatabase(databasePath);
const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: createApp(db).fetch, port }, (info) => {
  console.log(`Conty video review API listening on http://localhost:${info.port}`);
});

function close() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
