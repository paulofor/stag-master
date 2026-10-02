import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Only synthetic paths supplied by the isolated smoke harness, never client files.
const [operation, target] = process.argv.slice(2);
try {
  if (operation === "create") {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "arquivo sintético", "utf8");
  } else if (operation === "edit") appendFileSync(target, " · editado", "utf8");
  else if (operation !== "read") throw new Error("Operação de teste inválida.");
  console.log(JSON.stringify({ content: readFileSync(target, "utf8") }));
} catch (error) {
  console.error(JSON.stringify({ code: error.code || "TEST_ERROR" }));
  process.exitCode = 1;
}
