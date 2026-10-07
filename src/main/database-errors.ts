export function sqlServerError(error: unknown): string {
  const codes: string[] = [];
  const numbers: number[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    const item = value as { code?: string; number?: number; cause?: unknown; errors?: unknown[] };
    if (typeof item.code === "string") codes.push(item.code);
    if (typeof item.number === "number") numbers.push(item.number);
    visit(item.cause, depth + 1);
    for (const nested of (Array.isArray(item.errors) ? item.errors : []).slice(0, 10))
      visit(nested, depth + 1);
  };
  visit(error);
  if (numbers.includes(4060))
    return "O banco informado não está acessível. Confira o nome e as permissões do usuário.";
  if (codes.includes("ELOGIN") || numbers.includes(18456))
    return "Login recusado. Confira usuário, senha e a autenticação SQL Server habilitada no servidor.";
  if (codes.some((code) => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL/.test(code)))
    return "O certificado TLS não pôde ser validado. Confira o nome do certificado e a autoridade com o administrador do banco.";
  if (codes.includes("ETIMEOUT") || codes.includes("ETIMEDOUT"))
    return "O teste excedeu o prazo. Confira servidor, porta ou instância, VPN e firewall.";
  return "Não foi possível conectar ao SQL Server. Confira servidor, porta ou instância, banco, VPN e firewall.";
}

export function databaseTestError(error: unknown): string {
  const safe = [
    sqlServerError({ number: 4060 }),
    sqlServerError({ code: "ELOGIN" }),
    sqlServerError({ code: "CERT" }),
    sqlServerError({ code: "ETIMEOUT" }),
    "A conexão encerrou antes de concluir o teste.",
  ];
  return error instanceof Error && safe.includes(error.message)
    ? error.message
    : sqlServerError(error);
}
