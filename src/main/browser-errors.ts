// Chromium net/base/net_error_list.h. Do not include URLs or native error payloads.
export function browserLoadError(code: unknown): string {
  const number =
    typeof code === "number" && Number.isInteger(code) && code < 0 && code >= -999 ? code : null;
  switch (number) {
    case -202:
      return "Certificado HTTPS não confiável (ERR_CERT_AUTHORITY_INVALID, -202). Peça à TI para verificar a cadeia do site e a autoridade certificadora corporativa no Windows. Para um site conhecido, o cliente pode usar Abrir mesmo assim no painel e confirmar o risco. Autorizar navegador e Lembrar sessões não aceitam certificados.";
    case -201:
      return "Certificado HTTPS fora da validade (ERR_CERT_DATE_INVALID, -201). Confira a data e a hora do Windows. Se estiverem corretas, peça à TI para verificar a validade do certificado do site. Para um site conhecido, o cliente pode usar Abrir mesmo assim no painel e confirmar o risco.";
    case -200:
      return "O certificado HTTPS não corresponde ao endereço (ERR_CERT_COMMON_NAME_INVALID, -200). Confira o endereço e peça à TI para verificar os nomes cobertos pelo certificado. Para um site conhecido, o cliente pode usar Abrir mesmo assim no painel e confirmar o risco.";
    case -206:
      return "Certificado HTTPS revogado (ERR_CERT_REVOKED, -206). O acesso permanece bloqueado. Peça à TI para corrigir o certificado do site.";
    case -105:
      return "Endereço não encontrado (ERR_NAME_NOT_RESOLVED, -105). Confira o endereço e, se for um site interno, a conexão VPN e o DNS da rede.";
    case -106:
      return "Sem conexão de rede (ERR_INTERNET_DISCONNECTED, -106). Verifique a conexão e tente novamente.";
    case -3:
      return "Navegação interrompida. Tente novamente quando estiver pronto.";
  }
  if (number !== null && number <= -200 && number > -300)
    return `Não foi possível validar o certificado HTTPS (código ${number}). Peça à TI para verificar o certificado e a cadeia de confiança. O acesso permanece bloqueado.`;
  return `Não foi possível carregar a página${number === null ? "" : ` (código ${number})`}. Confira o endereço e a conexão ou tente novamente.`;
}
