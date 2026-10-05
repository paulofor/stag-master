import type { ProjectGitReport } from "../shared/types";

export function ProjectGitStatus({ report }: { report?: ProjectGitReport }) {
  if (!report) return null;
  return (
    <section className="project-git" aria-label="Preparação Git">
      <div role="status" aria-label="Estado do Git">
        {report.phase === "scanning"
          ? `Preparando Git… ${report.found} repositório(s) encontrado(s).`
          : report.failures
            ? `Git: ${report.verified} de ${report.found} repositório(s) verificado(s). Há pendências.`
            : report.found
              ? `Git pronto: ${report.verified} repositório(s) verificado(s).`
              : "Nenhum repositório Git encontrado na pasta e nas subpastas."}
      </div>
      {report.phase === "complete" &&
        (report.found > 0 || report.failures > 0 || report.skipped > 0) && (
          <details>
            <summary>Detalhes do Git</summary>
            <p>
              {report.added} raiz(es) adicionada(s) à confiança do Git deste usuário.
              {report.skipped > 0 && ` ${report.skipped} link(s) não percorrido(s).`}
              {report.incomplete && " A busca ficou incompleta."}
            </p>
            {report.issues.length > 0 && (
              <ul>
                {report.issues.map((issue, index) => (
                  <li key={index}>
                    <strong>{issue.path}</strong>: {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {report.failures > report.issues.length && (
              <p>Outras falhas foram omitidas deste resumo.</p>
            )}
          </details>
        )}
    </section>
  );
}
