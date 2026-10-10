import { describe, expect, it } from "vitest";
import { actionSchema, safeLink } from "../../src/shared/validation";
import { codexEnvironment } from "../../src/main/policy";
import { desktopArguments, DesktopTools } from "../../src/main/desktop-tools";

describe("fronteiras do cliente", () => {
  it("branches aceitam operações fixas, sem caminhos Git, opções de força ou consentimento do renderer", () => {
    const base = {
      type: "changeBranch",
      projectPath: "synthetic",
      revision: "f22df552-9b08-4bc9-ae94-d1307a147d67",
      repositoryId: "b412c04a-9859-4f69-83a3-9f39272124fa",
      operation: { kind: "delete", branch: "feature" },
    };
    expect(actionSchema.parse(base)).toEqual(base);
    for (const field of ["force", "gitDir", "repositoryPath", "command", "approved"]) {
      expect(() => actionSchema.parse({ ...base, [field]: true })).toThrow();
      expect(() =>
        actionSchema.parse({ ...base, operation: { ...base.operation, [field]: true } }),
      ).toThrow();
    }
    for (const kind of ["push", "pull", "fetch", "reset", "exec"])
      expect(() =>
        actionSchema.parse({ ...base, operation: { kind, branch: "feature" } }),
      ).toThrow();
  });
  it("não permite RPC arbitrário ou campos extras na ponte", () => {
    expect(() => actionSchema.parse({ type: "rpc", method: "command/exec" })).toThrow();
    expect(() => actionSchema.parse({ type: "connect", command: "unsafe" })).toThrow();
  });
  it("recusa a ação removida de movimento periódico, inclusive mensagens antigas", () => {
    for (const enabled of [true, false])
      expect(() =>
        actionSchema.parse({ type: "mouseMovement", threadId: "synthetic", enabled }),
      ).toThrow();
    const action = { type: "mouseMovement", threadId: "synthetic", enabled: true };
    for (const field of [
      "x",
      "y",
      "interval",
      "processId",
      "stagPeriodicMovement",
      "stagHostProcessId",
      "stagHostWindow",
      "script",
    ])
      expect(() => actionSchema.parse({ ...action, [field]: 1 })).toThrow();
    for (const field of ["stagHostProcessId", "stagHostWindow"])
      expect(() => desktopArguments.parse({ action: "list_windows", [field]: 42 })).toThrow();
    expect(() =>
      desktopArguments.parse({ action: "nudge_cursor", stagPeriodicMovement: true }),
    ).toThrow();
  });
  it("permite só http(s) e origens oficiais para OAuth", () => {
    for (const url of [
      "file:///C:/Windows",
      "javascript:alert(1)",
      "ms-excel:test",
      "https://user:password@example.com",
    ])
      expect(() => safeLink(url)).toThrow();
    expect(() => safeLink("https://auth.openai.com.evil.invalid/login", true)).toThrow();
    expect(() => safeLink("http://auth.openai.com/login", true)).toThrow();
    expect(safeLink("https://auth.openai.com/authorize", true)).toBe(
      "https://auth.openai.com/authorize",
    );
  });
  it("não herda segredos de conectores nem opções Node", () => {
    const env = codexEnvironment("isolated", {
      PATH: "path",
      META_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      CODEX_ACCESS_TOKEN: "secret",
      NODE_OPTIONS: "--require malicious.js",
      OPENAI_API_KEY: "secret",
      CODEX_HOME: "original",
    });
    expect(env).toEqual({ PATH: "path", CODEX_HOME: "isolated" });
  });
  it("valida parâmetros Windows antes da execução", async () => {
    for (const args of [
      { action: "send_keys", keys: "^s" },
      { action: "screenshot" },
      { action: "click", x: 10, y: 20 },
      { action: "scroll", x: 10, y: 20, delta: 120 },
      { action: "click", processId: 42, x: Infinity, y: 0 },
      { action: "list_windows", script: "anything" },
      { action: "focus_window", processId: -1 },
      { action: "type_text", text: "literal" },
      { action: "type_text", processId: 42, text: "literal", keys: "^a" },
      { action: "click", processId: 42, x: 0, y: 0, button: "unknown" },
      { action: "click", processId: 42, x: 0, y: 0, clicks: 3 },
      { action: "scroll", processId: 42, x: 0, y: 0, delta: 0 },
      { action: "scroll", processId: 42, x: 0, y: 0, delta: -1201 },
    ])
      expect(() => desktopArguments.parse(args)).toThrow();
    const tools = new DesktopTools("unused", "linux");
    await expect(tools.execute({ action: "list_windows" })).rejects.toThrow("Windows");
    expect(desktopArguments.parse({ action: "click", processId: 42, x: -1920, y: 10 })).toEqual({
      action: "click",
      processId: 42,
      x: -1920,
      y: 10,
    });
  });
});
