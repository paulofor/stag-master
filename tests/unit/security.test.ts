import { describe, expect, it } from "vitest";
import { actionSchema, safeLink } from "../../src/shared/validation";
import { codexEnvironment } from "../../src/main/policy";
import { desktopArguments, DesktopTools } from "../../src/main/desktop-tools";

describe("fronteiras do cliente", () => {
  it("não permite RPC arbitrário ou campos extras na ponte", () => {
    expect(() => actionSchema.parse({ type: "rpc", method: "command/exec" })).toThrow();
    expect(() => actionSchema.parse({ type: "connect", command: "unsafe" })).toThrow();
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
      { action: "click", x: Infinity, y: 0 },
      { action: "list_windows", script: "anything" },
      { action: "focus_window", processId: -1 },
      { action: "type_text", text: "literal" },
      { action: "type_text", processId: 42, text: "literal", keys: "^a" },
      { action: "click", x: 0, y: 0, button: "unknown" },
      { action: "click", x: 0, y: 0, clicks: 3 },
      { action: "scroll", x: 0, y: 0, delta: 0 },
      { action: "scroll", x: 0, y: 0, delta: -1201 },
    ])
      expect(() => desktopArguments.parse(args)).toThrow();
    const tools = new DesktopTools(
      "unused",
      async () => ({ success: true, contentItems: [] }),
      "linux",
    );
    await expect(tools.execute({ action: "list_windows" })).rejects.toThrow("Windows");
    expect(desktopArguments.parse({ action: "click", x: -1920, y: 10 })).toEqual({
      action: "click",
      x: -1920,
      y: 10,
    });
  });
});
