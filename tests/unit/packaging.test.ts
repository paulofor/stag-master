import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);
it.each([
  ["push", "refs/heads/main", "dist:win"],
  ["push", "refs/tags/v0.1.0", "release"],
  ["pull_request", "refs/pull/1/merge", "dist:win"],
])("gera artefato sem publicar em %s %s", async (event, ref, lifecycle) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL)/i.test(key),
    ),
  );
  const result = await run(process.execPath, [resolve("tests/fixtures/publish-policy.mjs")], {
    env: {
      ...env,
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      npm_lifecycle_event: lifecycle,
      PUBLISH_FOR_PULL_REQUEST: "true",
    },
    timeout: 10000,
  });
  expect(result.stdout).toContain("Artefato local sem publisher ou token de release: OK");
});
