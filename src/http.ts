import "dotenv/config";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { InMemoryEventStore } from "./mcp/inmemoryeventstore.js";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { setupServer } from "./mcp/index.js";

export async function startHttp() {
  const DEFAULT_PORT = Number(process.env.PORT ?? 3000);
  const app = express();
  app.use(express.json());

  // -------------------------------------------------------------
  //  Session bookkeeping – map sessionId => active transport
  // -------------------------------------------------------------
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Health route to verify server is running
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // -------------------------------------------------------------
  //  POST /mcp  ⟶  JSON-RPC request (init or follow-up)
  // -------------------------------------------------------------
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.header("mcp-session-id") ?? undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Existing session – reuse the same transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          eventStore,
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });

        // Ensure we drop the transport on close
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) delete transports[sid];
        };

        // Attach the transport to the server **before** handling
        const server = await setupServer();

        if (server === undefined) {
          process.exit(1);
        }

        await server.connect(transport);
      } else {
        // New session: only allowed for initialize request
        const { jsonrpc, method } = req.body ?? {};
        if (!(jsonrpc === "2.0" && method === "mcp.initialize")) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "First call must be mcp.initialize" },
            id: req.body?.id ?? null,
          });
          return;
        }

        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          eventStore,
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });

        // Ensure we drop the transport on close
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) delete transports[sid];
        };

        // Attach the transport to the server **before** handling
        const server = await setupServer();

        if (server === undefined) {
          process.exit(1);
        }

        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("POST /mcp error:", err);
      if (!res.headersSent) res.status(500).end();
    }
  });

  // -------------------------------------------------------------
  //  GET /mcp ⟶  Server-Sent-Events stream (notifications / chunks)
  // -------------------------------------------------------------
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send("Invalid session");
    } else {
      await transport.handleRequest(req, res); // SDK handles SSE + resumability
    }
  });

  // -------------------------------------------------------------
  //  DELETE /mcp ⟶  graceful session close
  // -------------------------------------------------------------
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send("Invalid session");
    } else {
      await transport.handleRequest(req, res); // calls server.endSession()
    }
  });

  // -------------------------------------------------------------
  //  Start / stop
  // -------------------------------------------------------------
  const serverHandle = app.listen(DEFAULT_PORT, () =>
    console.log(
      `🚀 MCP Streamable-HTTP listening on http://127.0.0.1:${DEFAULT_PORT}/mcp`,
    ),
  );

  process.on("SIGINT", async () => {
    console.log("\nShutting down…");

    // Close active transports → flush event streams
    await Promise.all(Object.values(transports).map((t) => t.close().catch(() => {})));

    serverHandle.close(() => process.exit(0));
  });
}
