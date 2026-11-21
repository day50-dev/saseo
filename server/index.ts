// API server: holds keys and proxies every external call, so keys never reach the browser.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type ConfigUpdate, SEARCHER_IDS, type SearcherId } from "../shared/providers.ts";
import { CONFIG_PATH, loadConfig, toPublic, updateConfig } from "./config.ts";
import { listModels, runSearch, testLlm, testSystemOne } from "./providers.ts";

const app = new Hono();

app.get("/api/config", async (c) => c.json(toPublic(await loadConfig())));

app.put("/api/config", async (c) => {
  const update = (await c.req.json()) as ConfigUpdate;
  return c.json(toPublic(await updateConfig(update)));
});

app.post("/api/test/llm", async (c) => c.json(await testLlm((await loadConfig()).llm)));

app.post("/api/test/systemone", async (c) =>
  c.json(await testSystemOne((await loadConfig()).systemOne)),
);

app.get("/api/models/:which", async (c) => {
  const which = c.req.param("which");
  if (which !== "llm" && which !== "systemOne") return c.json({ error: "unknown endpoint" }, 404);
  try {
    return c.json({ models: await listModels((await loadConfig())[which]) });
  } catch (err) {
    return c.json({ models: [], error: (err as Error).message });
  }
});

app.post("/api/search", async (c) => {
  const body = (await c.req.json()) as { query?: string; searchers?: string[]; count?: number };
  const query = body.query?.trim();
  if (!query) return c.json({ error: "query is required" }, 400);
  const config = await loadConfig();
  const ids = (body.searchers ?? SEARCHER_IDS.filter((id) => config.searchers[id].enabled)).filter(
    (id): id is SearcherId => (SEARCHER_IDS as readonly string[]).includes(id),
  );
  const count = Math.min(Math.max(body.count ?? 5, 1), 20);
  return c.json(await runSearch(config, query, ids, count));
});

// In production, serve the built panel too.
app.use("/*", serveStatic({ root: "./dist" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`semshapes API on http://127.0.0.1:${port} (config: ${CONFIG_PATH})`);
});
