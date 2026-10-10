import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  mkdir,
  symlink,
  rename,
  realpath,
  writeFile,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { downloadBrowserFile, browserDownloadLimit } from "../../src/main/browser-download";
import {
  browserArguments,
  browserTool,
  browserDownloadInstructions,
  browserConfirmationReason,
  browserApproval,
} from "../../src/main/browser-tools";
import { assistantInstructions } from "../../src/main/policy";

let root: string;
const pdf = Buffer.from("%PDF-1.7\nsynthetic test only\n%%EOF");
const zip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
beforeEach(async () => {
  // Windows TEMP can use a short/aliased path. The service always passes realpath.
  root = await realpath(await mkdtemp(join(tmpdir(), "stag-download-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const saved = async () => readdir(join(root, "stag-downloads")).catch(() => []);
const run = (fetch = vi.fn(async () => new Response(pdf)), extra = {}) =>
  downloadBrowserFile({
    url: "https://synthetic.invalid/file",
    context: { project: root, readOnly: false },
    fetch,
    signal: new AbortController().signal,
    progress: vi.fn(),
    ...extra,
  });

describe("download limitado para o projeto", () => {
  it("escolhe nome/subpasta, não sobrescreve nem aceita troca durante a transferência", async () => {
    const destination = "relatórios/retorno.pdf";
    const result = await run(undefined, { destination });
    expect(result.path).toBe(destination);
    expect(await readFile(join(root, destination))).toEqual(pdf);
    expect(await readdir(join(root, "relatórios"))).toEqual(["retorno.pdf"]);
    const fetch = vi.fn();
    await expect(run(fetch, { destination })).rejects.toThrow("já existe");
    expect(fetch).not.toHaveBeenCalled();
    const race = "relatórios/concorrente.pdf";
    await expect(
      run(
        vi.fn(async () => {
          await writeFile(join(root, race), "preservar");
          return new Response(pdf);
        }),
        { destination: race },
      ),
    ).rejects.toThrow();
    expect(await readFile(join(root, race), "utf8")).toBe("preservar");
    expect(await readdir(join(root, "relatórios"))).toHaveLength(2);
  });
  it.each([
    "../outside.pdf",
    "/outside.pdf",
    "C:\\pasta\\file.pdf",
    "\\\\server\\file.pdf",
    "pasta/../file.pdf",
    "pasta//file.pdf",
    "pasta/.git/file.pdf",
    ".stag/memoria.txt",
    "pasta/.env.txt",
    "pasta/CON.pdf",
    "pasta/CON .pdf",
    "CONIN$.txt",
    "pasta/nul.txt",
    "a.pdf:secret",
    "pasta./file.pdf",
    "a.pdf ",
    "setup.exe",
    "node_modules/a.pdf",
    "a/../../b.csv",
  ])("recusa destino inválido antes da rede: %s", async (destination) => {
    const fetch = vi.fn();
    await expect(run(fetch, { destination })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    expect(
      browserArguments.safeParse({ action: "download", pageId: "p", ref: "e1", destination })
        .success,
    ).toBe(false);
  });
  it("destinos recusam links/junctions, hardlinks e extensão incompatível sem perder o original", async () => {
    const outside = join(root, "vizinho");
    await mkdir(outside);
    await symlink(outside, join(root, "atalho"), process.platform === "win32" ? "junction" : "dir");
    await expect(run(undefined, { destination: "atalho/a.pdf" })).rejects.toThrow("link");
    expect(await readdir(outside)).toEqual([]);
    await writeFile(join(root, "original.pdf"), pdf);
    await link(join(root, "original.pdf"), join(root, "hard.pdf"));
    await expect(run(undefined, { destination: "hard.pdf" })).rejects.toThrow("já existe");
    expect(await readFile(join(root, "original.pdf"))).toEqual(pdf);
    await expect(run(undefined, { destination: "relatorio.xlsx" })).rejects.toThrow("extensão");
    expect(await readdir(root)).not.toContain("relatorio.xlsx");
    const args = browserArguments.parse({
      action: "download",
      pageId: "p",
      ref: "e1",
      destination: "exports/retorno.xlsx",
      trigger: "click",
      risk: "critical",
      intent: "Exportar relatório sintético",
    });
    expect(browserApproval(args, "Confirme exportação").detail).toContain("exports/retorno.xlsx");
  });
  it.each([
    ["xlsx", zip],
    ["xls", Buffer.from("d0cf11e0a1b11ae100000000", "hex")],
    ["csv", Buffer.from("empresa;valor\nSintética;10\n")],
    ["json", Buffer.from('{"fixture":true}')],
    ["xml", Buffer.from('<?xml version="1.0"?><fixture/>')],
    ["txt", Buffer.from("evidência sintética")],
  ])(
    "grava exportação %s sem carregar integralmente, sem abrir e sem executar",
    async (format, bytes) => {
      const result = await run(
        vi.fn(async () => new Response(bytes)),
        { destination: `exports/file.${format}` },
      );
      expect(result.format).toBe(format);
      expect(await readFile(join(root, result.path))).toEqual(bytes);
      expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    },
  );
  it("grava exportação nativa no mesmo destino validado e limpa falha parcial", async () => {
    const fetch = vi.fn();
    const native = vi.fn(async (path: string) => {
      await writeFile(path, zip);
      return { filename: "../../retorno.xlsx", mime: "application/octet-stream" };
    });
    const result = await run(fetch, { native, destination: "exports/retorno.xlsx" });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.path).toBe("exports/retorno.xlsx");
    expect(result.format).toBe("xlsx");
    expect(await readFile(join(root, result.path))).toEqual(zip);
    await expect(
      run(fetch, {
        destination: "exports/falhou.xlsx",
        native: async (path: string) => {
          await writeFile(path, "partial");
          throw new Error("SYNTHETIC_SECRET");
        },
      }),
    ).rejects.not.toThrow("SYNTHETIC_SECRET");
    expect(await readdir(join(root, "exports"))).toEqual(["retorno.xlsx"]);
    await run(fetch, { native, destination: "exports/recuperado.xlsx" });
  });
  it("recusa HTML/login, conteúdo binário e UTF-8 truncado disfarçados de CSV", async () => {
    for (const bytes of [
      Buffer.from("<html>login</html>"),
      Buffer.from("MZ fixture"),
      Buffer.from([97, 0, 98]),
      Buffer.from([0xc3]),
    ])
      await expect(
        run(
          vi.fn(async () => new Response(bytes)),
          { destination: "f.csv" },
        ),
      ).rejects.toThrow("formato");
    await expect(
      run(
        vi.fn(
          async () => new Response("<h1>login</h1>", { headers: { "Content-Type": "text/html" } }),
        ),
        { destination: "f.csv" },
      ),
    ).rejects.toThrow("formato");
    expect(await readdir(root)).toEqual([]);
  });
  it("grava bytes íntegros, checksum e caminhos exclusivos para PDF e ZIP sem extrair", async () => {
    const progress = vi.fn();
    for (const bytes of [pdf, zip, pdf]) {
      const fetch = vi.fn(
        async () =>
          new Response(bytes, {
            headers: {
              "Content-Length": String(bytes.length),
              "Content-Disposition": 'attachment; filename="../../secret.exe"',
            },
          }),
      );
      const result = (await run(fetch, { progress }))!;
      expect(await readFile(join(root, result.path))).toEqual(bytes);
      expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(result.bytes).toBe(bytes.length);
      expect(result.path).toMatch(/^stag-downloads\/download-[^/]+\/(documento.pdf|arquivo.zip)$/);
      expect(fetch).toHaveBeenCalledWith(
        "https://synthetic.invalid/file",
        expect.objectContaining({
          method: "GET",
          redirect: "manual",
          credentials: "include",
          cache: "no-store",
        }),
      );
    }
    expect(await saved()).toHaveLength(3);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ status: "downloading" }));
  });
  it.each([
    ["HTML/login", "<html>login</html>", 200, {}],
    ["executável", "MZ synthetic", 200, {}],
    ["vazio", "", 200, {}],
    ["HTTP negado", pdf, 403, {}],
    ["parcial HTTP", pdf, 206, {}],
    ["truncado", pdf, 200, { "Content-Length": "500" }],
    ["excesso declarado", pdf, 200, { "Content-Length": String(browserDownloadLimit + 1) }],
  ])("recusa %s e remove parcial", async (_name, body, status, headers) => {
    await expect(run(vi.fn(async () => new Response(body, { status, headers })))).rejects.toThrow();
    expect(await saved()).toEqual([]);
    expect((await run())!.format).toBe("pdf");
  });
  it("limita os bytes sem Content-Length e cancela o stream", async () => {
    let chunks = 0,
      canceled = false;
    const chunk = Buffer.alloc(1024 * 1024);
    pdf.copy(chunk);
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          chunks++;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      }),
    );
    await expect(run(vi.fn(async () => response))).rejects.toThrow("100 MiB");
    expect(chunks).toBeLessThanOrEqual(103);
    expect(canceled).toBe(true);
    expect(await saved()).toEqual([]);
  });
  it("recusa Leitura antes da rede ou escrita e não aceita autoridade pública no schema", async () => {
    const fetch = vi.fn();
    await expect(run(fetch, { context: { project: root, readOnly: true } })).rejects.toThrow(
      "Leitura",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    for (const extra of [
      { url: "https://evil.invalid/" },
      { project: root },
      { readOnly: false },
      { headers: {} },
      { path: "x.pdf" },
    ])
      expect(
        browserArguments.safeParse({ action: "download", pageId: "page", ...extra }).success,
      ).toBe(false);
    expect(browserTool.inputSchema.properties.action.enum).toContain("download");
    expect(
      browserConfirmationReason({
        action: "download",
        pageId: "p",
        risk: "critical",
        intent: "Consulta sintética",
      }),
    ).toBeTruthy();
    expect(
      browserConfirmationReason({
        action: "download",
        pageId: "p",
        ref: "e1",
        risk: "routine",
        intent: "Consulta sintética",
      }),
    ).toBeNull();
    for (const mode of ["read", "project", "windows"] as const)
      expect(assistantInstructions(mode, "win32")).toContain(browserDownloadInstructions);
  });
  it("valida redirects, impede downgrade/protocolos e não repete erros", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "/next" } }))
      .mockResolvedValueOnce(new Response(pdf));
    await run(fetch);
    expect(fetch.mock.calls[1][0]).toBe("https://synthetic.invalid/next");
    for (const Location of [
      "file:///private",
      "http://synthetic.invalid/file",
      "https://user:secret@synthetic.invalid/file",
      "data:text/html,a",
    ]) {
      const blocked = vi.fn(async () => new Response(null, { status: 302, headers: { Location } }));
      await expect(run(blocked)).rejects.toThrow();
      expect(blocked).toHaveBeenCalledTimes(1);
    }
    const loop = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "/loop" } }),
    );
    await expect(run(loop)).rejects.toThrow("redirecionamentos");
    expect(loop).toHaveBeenCalledTimes(6);
  });
  it("recusa link/junction no destino, preserva projeto vizinho e recupera", async () => {
    const neighbor = join(root, "neighbor");
    await mkdir(neighbor);
    await symlink(
      neighbor,
      join(root, "stag-downloads"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const fetch = vi.fn();
    await expect(run(fetch)).rejects.toThrow("link");
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(neighbor)).toEqual([]);
    await rm(join(root, "stag-downloads"));
    await run();
  });
  it("recebe a raiz canônica da seleção mesmo quando a pasta temporária usa alias", async () => {
    const physical = join(root, "project");
    const alias = join(root, "project-alias");
    await mkdir(physical);
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
    const fetch = vi.fn(async () => new Response(pdf));
    await expect(run(fetch, { context: { project: alias, readOnly: false } })).rejects.toThrow(
      "link",
    );
    expect(fetch).not.toHaveBeenCalled();
    const canonical = await realpath(alias);
    const result = await run(fetch, { context: { project: canonical, readOnly: false } });
    expect(await readFile(join(canonical, result.path))).toEqual(pdf);
  });
  it("cancela com limpeza, não retorna caminho parcial e permite nova tentativa", async () => {
    const controller = new AbortController();
    await expect(
      run(undefined, { signal: controller.signal, progress: () => controller.abort() }),
    ).rejects.toThrow("cancelado");
    expect(await saved()).toEqual([]);
    await run();
  });
  it("não grava quando a raiz é substituída durante a rede", async () => {
    const project = join(root, "project");
    await mkdir(project);
    const original = join(root, "original");
    const fetch = vi.fn(async () => {
      await rename(project, original);
      await mkdir(project);
      return new Response(pdf);
    });
    await expect(run(fetch, { context: { project, readOnly: false } })).rejects.toThrow("pasta");
    expect(await readdir(project)).toEqual([]);
  });
  it("erros de disco/rede e TLS são sanitizados sem ecos de URL/token", async () => {
    for (const message of [
      "SYNTHETIC_TOKEN https://private.invalid/?secret=fixture",
      "net::ERR_CERT_AUTHORITY_INVALID https://private.invalid",
    ]) {
      const fetch = vi.fn(async () => {
        throw new Error(message);
      });
      const result = await run(fetch).catch((e: Error) => e.message);
      expect(result).not.toMatch(/SYNTHETIC_TOKEN|private.invalid|secret=fixture/);
      if (message.includes("ERR_CERT")) expect(result).toContain("TLS");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});
