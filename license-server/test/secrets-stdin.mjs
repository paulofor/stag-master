// Fixed test-only bootstrap for Docker engines that cannot bind the checkout's filesystem.
// Credentials enter on stdin, never in the image, environment, arguments or logs.
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16384) throw new Error("Limite do bootstrap sintético.");
}
const values = JSON.parse(input);
const names = [
  "postgres_password",
  "admin_password_hash",
  "signing_key",
  "postgres_admin_password",
];
if (
  Object.keys(values).length !== names.length ||
  names.some((n) => typeof values[n] !== "string" || values[n].length > 8192)
)
  throw new Error("Secrets sintéticos inválidos.");
for (const name of names.filter((n) => n !== "postgres_admin_password"))
  writeFileSync("/api-secrets/" + name, values[name], { mode: 0o444, flag: "wx" });
writeFileSync("/db-secrets/postgres_password", values.postgres_password, {
  mode: 0o444,
  flag: "wx",
});
writeFileSync("/db-secrets/postgres_admin_password", values.postgres_admin_password, {
  mode: 0o444,
  flag: "wx",
});
