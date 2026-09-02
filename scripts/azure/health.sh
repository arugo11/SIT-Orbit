#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to the demo resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to the Container App name.}"
: "${ORBIT_AZURE_SUBSCRIPTION:?Set ORBIT_AZURE_SUBSCRIPTION to the Azure for Students subscription ID.}"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${project_root}/scripts/azure/_students_guard.sh"
require_azure_for_students_subscription

IFS='|' read -r container_app_id container_app_state <<< "$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --subscription "${ORBIT_AZURE_SUBSCRIPTION}" \
  --query "join('|',[id,properties.provisioningState])" \
  --output tsv)"
if [[ "${container_app_id,,}" != "/subscriptions/${AZURE_STUDENTS_SUBSCRIPTION_ID,,}"/* ]]; then
  printf 'Container App is outside the selected subscription.\n' >&2
  exit 1
fi
if [[ "${container_app_state}" != "Succeeded" ]]; then
  printf 'Container App must be in Succeeded state.\n' >&2
  exit 1
fi

IFS='|' read -r healthy_revision traffic_weight revision_state revision_health revision_backend revision_model revision_base <<< "$(az containerapp revision list \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --subscription "${ORBIT_AZURE_SUBSCRIPTION}" \
  --query "[?properties.trafficWeight==\`100\` && properties.runningState=='Running' && properties.healthState=='Healthy'] | [0] | join('|',[name,to_string(properties.trafficWeight),properties.runningState,properties.healthState,properties.template.containers[0].env[?name=='ORBIT_AGENT_BACKEND'].value | [0],properties.template.containers[0].env[?name=='AZURE_OPENAI_MODEL'].value | [0],properties.template.containers[0].env[?name=='AZURE_OPENAI_BASE_MODEL'].value | [0]])" \
  --output tsv)"
if [[ "${healthy_revision}" == "" || "${traffic_weight}" != "100" ||
  "${revision_state}" != "Running" || "${revision_health}" != "Healthy" ||
  "${revision_backend}" != "azure_openai" || "${revision_model}" != "gpt-5-6-terra" ||
  "${revision_base}" != "gpt-5.6-terra" ]]; then
  printf 'No Healthy Azure native Tool Search revision has 100%% traffic.\n' >&2
  exit 1
fi

show_args=(
  containerapp show
  --name "${ORBIT_AZURE_CONTAINER_APP}"
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}"
  --query properties.configuration.ingress.fqdn
  --output tsv
  --only-show-errors
)
show_args+=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")

fqdn="$(az "${show_args[@]}")"
if [[ -z "${fqdn}" ]]; then
  printf 'The Container App has no external ingress hostname.\n' >&2
  exit 1
fi

curl --fail --silent --show-error --max-time "${ORBIT_HEALTH_TIMEOUT_SECONDS:-30}" "https://${fqdn}/health"
printf '\n'
printf 'Healthy revision %s: backend=%s deployment=%s base_model=%s\n' \
  "${healthy_revision}" "${revision_backend}" "${revision_model}" "${revision_base}"
