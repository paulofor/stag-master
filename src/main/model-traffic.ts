/** Overrides apply only to the Codex process launched by STAG Plus, never the user's config file. */
export const modelTrafficConfig = {
  "analytics.enabled": false,
  "feedback.enabled": false,
  "otel.exporter": "none",
  "otel.trace_exporter": "none",
  "otel.metrics_exporter": "none",
  "otel.log_user_prompt": false,
  model_reasoning_summary: "none",
  model_verbosity: "low",
} as const;

export const modelTrafficArguments = Object.entries(modelTrafficConfig).flatMap(([key, value]) => [
  "-c",
  `${key}=${JSON.stringify(value)}`,
]);

export const modelTrafficInstructions = `Economia de dados: responda de forma concisa, sem repetir a solicitação, contratos, resultados de ferramentas ou código que já foi apresentado; inclua o detalhe necessário para concluir e verificar a tarefa. Leia arquivos e logs por busca e trechos pertinentes, ampliando a leitura quando necessário; evite despejar arquivos, históricos, binários, dependências e logs inteiros. No navegador prefira snapshot textual; use screenshot quando a informação visual for necessária. Em APIs prefira filtros, paginação e campos pertinentes quando suportados pelo serviço, sem repetir operações com efeitos. Não omita requisitos, erros, evidências, fontes, aprovações ou informações relevantes para economizar. Preserve as notas .stag e o histórico; não reduza o escopo do trabalho. Imagens podem usar compressão JPEG mantendo dimensões; se detalhes não estiverem legíveis, informe a limitação em vez de adivinhar.`;
