#!/usr/bin/env bash
set -euo pipefail
umask 077

task_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_project=${LICENSE_COMPOSE_PROJECT:?Informe o projeto Compose da instancia}
task_env=${LICENSE_COMPOSE_ENV:-"$task_directory/.env"}
if [[ ! "$task_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  printf '%s\n' 'Projeto Compose invalido.' >&2
  exit 1
fi
task_compose=(docker compose -p "$task_project" --env-file "$task_env" -f "$task_directory/compose.yaml")
task_action=${1:-}
task_file=${2:-}
if [[ -z "$task_file" || -L "$task_file" ]]; then
  printf '%s\n' 'Informe um arquivo local regular para backup/restauracao.' >&2
  exit 1
fi
case "$task_action" in
  backup)
    if [[ -e "$task_file" ]]; then
      printf '%s\n' 'O destino ja existe; nao sera sobrescrito.' >&2
      exit 1
    fi
    task_temporary=$(mktemp "${task_file}.XXXXXX")
    trap 'rm -f -- "$task_temporary"' EXIT
    "${task_compose[@]}" exec -T postgres sh -c 'read -r PGPASSWORD < /run/secrets/postgres_admin_password; export PGPASSWORD; exec pg_dump -U postgres -d stag_licenses --format=custom' > "$task_temporary"
    [[ -s "$task_temporary" ]]
    # An exclusive hard link prevents an intervening destination from being overwritten.
    ln -- "$task_temporary" "$task_file"
    rm -f -- "$task_temporary"
    trap - EXIT
    printf '%s\n' 'Backup concluido. Preserve tambem os segredos da instancia em armazenamento protegido.'
    ;;
  restore)
    if [[ ${3:-} != --confirm-replace || ! -f "$task_file" ]]; then
      printf '%s\n' 'Restauracao substitui os cadastros; exige --confirm-replace e arquivo regular.' >&2
      exit 1
    fi
    "${task_compose[@]}" exec -T postgres sh -c 'read -r PGPASSWORD < /run/secrets/postgres_admin_password; export PGPASSWORD; exec pg_restore -U postgres -d stag_licenses --clean --if-exists --single-transaction' < "$task_file"
    printf '%s\n' 'Restauracao concluida. Confira saude e cadastros antes de liberar o acesso.'
    ;;
  *)
    printf '%s\n' 'Uso: backup.sh backup arquivo.dump | restore arquivo.dump --confirm-replace' >&2
    exit 1
    ;;
esac
