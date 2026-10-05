import { writeFileSync } from "node:fs";

// Handshake before advancing the test clock; no repository, auth or external process.
writeFileSync(process.argv[2], "ready");
setInterval(() => {}, 1000);
