import { DefaultAzureCredential } from "@azure/identity";
import { createGraphSqlClient, initializeGraphSchema } from "@vkg/shared/server";
import { runtimeGrantStatement } from "./bootstrap-statements.js";

async function main(): Promise<void> {
  const sqlGraphServer = process.env.SQL_GRAPH_SERVER ?? "";
  const sqlGraphDatabase = process.env.SQL_GRAPH_DATABASE ?? "video-graph";
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.database\.windows\.net$/i.test(sqlGraphServer) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sqlGraphDatabase) ||
      !clientId || !/^[0-9a-f-]{36}$/i.test(clientId)) {
    throw new Error("Invalid bootstrap SQL or managed identity configuration");
  }
  const grantSql = runtimeGrantStatement(
    process.env.BOOTSTRAP_RUNTIME_USER ?? "video-kg-runtime",
    process.env.RUNTIME_IDENTITY_CLIENT_ID ?? ""
  );
  const config = { sqlGraphServer, sqlGraphDatabase };
  const credential = new DefaultAzureCredential({ managedIdentityClientId: clientId });
  await initializeGraphSchema(config, credential);
  const client = createGraphSqlClient(config, credential);
  try {
    await client.query(grantSql, []);
    const tables = await client.query(
      "SELECT name, is_node, is_edge FROM sys.tables WHERE schema_id = SCHEMA_ID(N'vkg');", []
    );
    if (!tables.some(table => table.is_node === true || table.is_node === 1) ||
        !tables.some(table => table.is_edge === true || table.is_edge === 1)) {
      throw new Error("Native node and edge tables were not created");
    }
    console.log("[bootstrap-graph] native node/edge schema initialized; runtime identity has schema-scoped data grants");
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "number" in error && typeof error.number === "number"
    ? error.number : undefined;
  console.error(JSON.stringify({ event: "graph_bootstrap_failed", sqlErrorNumber: code, name: error instanceof Error ? error.name : "Error" }));
  process.exitCode = 1;
});
