import { createServices, loadConfig } from "@vkg/shared/server";
import { createApp } from "./app.js";

const config = loadConfig();
const services = createServices(config);
const app = createApp(services);
const host = config.authDisabled ? "127.0.0.1" : "0.0.0.0";
const server = app.listen(config.port, host, () => {
  console.log(`video-kg-api listening on ${host}:${config.port}`);
});
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 30_000;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}
