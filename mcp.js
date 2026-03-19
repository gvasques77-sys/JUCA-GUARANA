import 'dotenv/config';
import express from "express";
import cors from "cors";
import pino from 'pino';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { schedulingToolsDefinitions, executeSchedulingTool } from "./tools/schedulingTools.js";

const log = pino({
  transport: { target: 'pino-pretty' },
});

const app = express();
app.use(cors());
app.use(express.json());

const mcpServer = new Server(
  {
    name: "juca-guarana-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

mcpServer.setRequestHandler("listTools", async () => {
  return {
    tools: schedulingToolsDefinitions.map((def) => ({
      name: def.function.name,
      description: def.function.description,
      inputSchema: def.function.parameters,
    })),
  };
});

mcpServer.setRequestHandler("callTool", async (request) => {
  const { name, arguments: args } = request.params;
  const clinicId = process.env.CLINIC_ID || "e229eb6c-aab3-4b48-957d-525165d175c4";

  try {
    const result = await executeSchedulingTool(name, args, { clinicId });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Erro ao executar ferramenta ${name}: ${error.message}`,
        },
        {
          type: "text",
          text: error.stack,
        }
      ],
      isError: true,
    };
  }
});

let mcpTransport;

app.get("/mcp", async (req, res) => {
  log.info("Nova conexão MCP (SSE) iniciada");
  mcpTransport = new SSEServerTransport(req, res);
  await mcpServer.connect(mcpTransport);
});

app.post("/mcp", async (req, res) => {
  log.info("Mensagem MCP recebida (POST)");
  mcpTransport = new SSEServerTransport(req, res);
  await mcpServer.connect(mcpTransport);
  await mcpTransport.handlePostMessage(req, res);
});

app.get("/health", async (req, res) => {
  res.json({ ok: true, service: "juca-guarana-mcp" });
});

const PORT = process.env.MCP_PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  log.info(`Servidor MCP JUCA GUARANÁ rodando na porta ${PORT}`);
  log.info(`Endpoint MCP: /mcp`);
});
