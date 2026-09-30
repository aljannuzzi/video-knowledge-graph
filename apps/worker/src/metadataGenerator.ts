// Compatibility entrypoint for existing deployment commands; runs the real worker.
import { main } from "./worker.js";

void main().catch(() => {
  console.error("[worker] startup or runtime failure");
  process.exitCode = 1;
});
