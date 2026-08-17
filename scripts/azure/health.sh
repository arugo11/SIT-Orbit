#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"

show_args=(
  containerapp show
  --name "${ORBIT_AZURE_CONTAINER_APP}"
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}"
  --query properties.configuration.ingress.fqdn
  --output tsv
  --only-show-errors
)
if [[ -n "${ORBIT_AZURE_SUBSCRIPTION:-}" ]]; then
  show_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")
fi

fqdn="$(az "${show_args[@]}")"
if [[ -z "${fqdn}" ]]; then
  printf 'The Container App has no external ingress hostname.\n' >&2
  exit 1
fi

curl --fail --silent --show-error --max-time "${ORBIT_HEALTH_TIMEOUT_SECONDS:-30}" "https://${fqdn}/health"
printf '\n'
