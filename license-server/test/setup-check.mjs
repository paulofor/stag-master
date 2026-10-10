// Read only the private bootstrap files in this test's /setup mount; emit booleans, never values.
import { readFile, lstat } from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { checkPassword } from "./dist/security.js";
const directory = "/setup/.secrets";
const password = await readFile(directory + "/initial-admin-password.txt", "utf8");
const hash = await readFile(directory + "/admin-password-hash.txt", "utf8");
const signer = createPrivateKey(await readFile(directory + "/signing-key.pem", "utf8"));
const publicKey = await readFile(directory + "/public-key.pem", "utf8");
const publicConfig = await readFile("/setup/.env", "utf8");
process.stdout.write(
  JSON.stringify({
    privateDirectory: ((await lstat(directory)).mode & 0o777) === 0o700,
    privatePassword:
      ((await lstat(directory + "/initial-admin-password.txt")).mode & 0o777) === 0o600,
    validPassword: await checkPassword(password, hash),
    validKey:
      signer.asymmetricKeyType === "ed25519" &&
      createPublicKey(signer).export({ type: "spki", format: "pem" }) === publicKey,
    publicConfig: !publicConfig.includes(password) && !publicConfig.includes("PRIVATE KEY"),
  }),
);
