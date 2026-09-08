#!/usr/bin/env bash
set -euo pipefail

: "${ORBIT_AZURE_SUBSCRIPTION:?Set ORBIT_AZURE_SUBSCRIPTION to the Azure for Students subscription ID.}"
: "${ORBIT_AZURE_RESOURCE_GROUP:?Set ORBIT_AZURE_RESOURCE_GROUP to an existing resource group.}"
: "${ORBIT_AZURE_CONTAINER_APP:?Set ORBIT_AZURE_CONTAINER_APP to an existing Container App.}"
: "${ORBIT_AZURE_ENVIRONMENT_ID:?Set ORBIT_AZURE_ENVIRONMENT_ID to an existing Container Apps environment resource ID.}"
: "${ORBIT_AZURE_REGISTRY:?Set ORBIT_AZURE_REGISTRY to an existing Azure Container Registry name.}"
: "${ORBIT_AZURE_OPENAI_ACCOUNT:?Set ORBIT_AZURE_OPENAI_ACCOUNT to an existing Azure OpenAI account name.}"
: "${ORBIT_CORS_ORIGINS:?Set ORBIT_CORS_ORIGINS to the exact extension origin.}"
: "${ORBIT_AZURE_IMAGE_TAG:?Set ORBIT_AZURE_IMAGE_TAG to a non-empty candidate image tag.}"

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${project_root}/scripts/azure/_students_guard.sh"
require_azure_for_students_subscription
subscription_args=(--subscription "${ORBIT_AZURE_SUBSCRIPTION}")

if [[ ! "${ORBIT_AZURE_IMAGE_TAG}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  printf 'ORBIT_AZURE_IMAGE_TAG contains unsupported characters.\n' >&2
  exit 1
fi

canonical_model="${AZURE_OPENAI_BASE_MODEL:-gpt-5.6-terra}"
deployment_model="${AZURE_OPENAI_MODEL:-gpt-5-6-terra}"
if [[ "${canonical_model}" != "gpt-5.6-terra" || "${deployment_model}" != "gpt-5-6-terra" ]]; then
  printf 'The candidate must use AZURE_OPENAI_MODEL=gpt-5-6-terra and AZURE_OPENAI_BASE_MODEL=gpt-5.6-terra.\n' >&2
  exit 1
fi

assert_same_subscription() {
  local resource_id="$1"
  local expected="/subscriptions/${AZURE_STUDENTS_SUBSCRIPTION_ID,,}"
  if [[ "${resource_id,,}" != "${expected}"/* ]]; then
    printf 'Resource is outside the selected Azure for Students subscription.\n' >&2
    return 1
  fi
}

group_id="$(az group show \
  --name "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query id \
  --output tsv)"
assert_same_subscription "${group_id}"

IFS='|' read -r environment_id environment_type environment_state <<< "$(az resource show \
  --ids "${ORBIT_AZURE_ENVIRONMENT_ID}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,type,properties.provisioningState])" \
  --output tsv)"
assert_same_subscription "${environment_id}"
if [[ "${environment_id}" != "${ORBIT_AZURE_ENVIRONMENT_ID}" || \
  "${environment_type}" != "Microsoft.App/managedEnvironments" || \
  "${environment_state}" != "Succeeded" ]]; then
  printf 'The existing Container Apps environment must be in Succeeded state.\n' >&2
  exit 1
fi

IFS='|' read -r registry_id registry_server registry_role_assignment_mode registry_state <<< "$(az acr show \
  --name "${ORBIT_AZURE_REGISTRY}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,loginServer,roleAssignmentMode,provisioningState])" \
  --output tsv)"
assert_same_subscription "${registry_id}"
if [[ "${registry_state}" != "Succeeded" ]]; then
  printf 'The existing Azure Container Registry must be in Succeeded state.\n' >&2
  exit 1
fi
case "${registry_role_assignment_mode}" in
  LegacyRegistryPermissions) registry_pull_role="AcrPull" ;;
  AbacRepositoryPermissions) registry_pull_role="Container Registry Repository Reader" ;;
  *)
    printf 'Unsupported ACR role assignment mode: %s\n' "${registry_role_assignment_mode}" >&2
    exit 1
    ;;
esac
authentication_as_arm="$(az acr config authentication-as-arm show \
  --registry "${ORBIT_AZURE_REGISTRY}" \
  "${subscription_args[@]}" \
  --query status \
  --output tsv)"
if [[ "${authentication_as_arm}" != "enabled" ]]; then
  printf 'ACR authentication-as-arm must already be enabled.\n' >&2
  exit 1
fi

identity_name="${ORBIT_AZURE_IDENTITY:-${ORBIT_AZURE_CONTAINER_APP}-pull}"
IFS='|' read -r identity_id identity_principal_id <<< "$(az identity show \
  --name "${identity_name}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,principalId])" \
  --output tsv)"
assert_same_subscription "${identity_id}"
if [[ -z "${identity_principal_id}" ]]; then
  printf 'The existing pull identity must expose a principal ID.\n' >&2
  exit 1
fi

acr_pull_assignment="$(az role assignment list \
  --scope "${registry_id}" \
  "${subscription_args[@]}" \
  --query "[?principalId=='${identity_principal_id}' && roleDefinitionName=='${registry_pull_role}'].id | [0]" \
  --output tsv)"
if [[ -z "${acr_pull_assignment}" ]]; then
  printf 'The existing identity has no ACR pull role; refusing to create a role assignment.\n' >&2
  exit 1
fi

IFS='|' read -r app_id app_state current_environment app_revision_mode <<< "$(az containerapp show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,properties.provisioningState,properties.environmentId,properties.configuration.activeRevisionsMode])" \
  --output tsv)"
assert_same_subscription "${app_id}"
if [[ "${app_state}" != "Succeeded" ]]; then
  printf 'The existing Container App must be in Succeeded state.\n' >&2
  exit 1
fi
if [[ "${current_environment,,}" != "${environment_id,,}" ]]; then
  printf 'The existing Container App uses a different environment.\n' >&2
  exit 1
fi

IFS='|' read -r openai_id openai_endpoint openai_state <<< "$(az cognitiveservices account show \
  --name "${ORBIT_AZURE_OPENAI_ACCOUNT}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,properties.endpoint,properties.provisioningState])" \
  --output tsv)"
assert_same_subscription "${openai_id}"
if [[ -z "${openai_endpoint}" || "${openai_state}" != "Succeeded" ]]; then
  printf 'The existing Azure OpenAI account must be in Succeeded state.\n' >&2
  exit 1
fi
IFS='|' read -r openai_deployment_id openai_deployment_state openai_deployment_model <<< "$(az cognitiveservices account deployment show \
  --name "${ORBIT_AZURE_OPENAI_ACCOUNT}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --deployment-name "${deployment_model}" \
  "${subscription_args[@]}" \
  --query "join('|',[id,properties.provisioningState,properties.model.name])" \
  --output tsv)"
assert_same_subscription "${openai_deployment_id}"
if [[ "${openai_deployment_state}" != "Succeeded" ||
  "${openai_deployment_model}" != "${canonical_model}" ]]; then
  printf 'The existing Azure OpenAI deployment must be Succeeded and use the canonical model.\n' >&2
  exit 1
fi

# Native Tool Search support is a local, dependency-pinned preflight. It does
# not call Azure and refuses an unsupported canonical profile before mutation.
PYTHONPATH="${project_root}/services/api" uv run python - <<'PY'
from orbit_api.agent.native_tool_search import validate_native_tool_search_profile
validate_native_tool_search_profile("gpt-5.6-terra")
PY

# Do not mutate the registry or Container App until a known-good revision is
# confirmed. This is the rollback anchor for the zero-traffic candidate.
previous_revision="$(az containerapp revision list \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "[?properties.trafficWeight==\`100\` && (properties.runningState=='Running' || properties.runningState=='RunningAtMaxScale' || properties.runningState=='ScaledToZero') && properties.healthState=='Healthy'].name | [0]" \
  --output tsv)"
if [[ -z "${previous_revision}" ]]; then
  printf 'A prior Healthy revision with 100%% traffic is required before rollout.\n' >&2
  exit 1
fi

image_repository="${ORBIT_AZURE_IMAGE_REPOSITORY:-sit-orbit-api}"
az acr build \
  --registry "${ORBIT_AZURE_REGISTRY}" \
  --image "${image_repository}:${ORBIT_AZURE_IMAGE_TAG}" \
  --file "${project_root}/Dockerfile" \
  --platform linux/amd64 \
  "${subscription_args[@]}" \
  "${project_root}"

image="${registry_server}/${image_repository}:${ORBIT_AZURE_IMAGE_TAG}"
revision_suffix="native-tool-search-${ORBIT_AZURE_IMAGE_TAG//[^A-Za-z0-9-]/-}"
# Azure limits the combined app-name plus suffix to 54 characters. Keep the
# suffix deterministic while deriving the maximum from the existing app name.
max_suffix_length=$((54 - ${#ORBIT_AZURE_CONTAINER_APP} - 2))
if (( max_suffix_length < 1 )); then
  printf 'Container App name leaves no room for a revision suffix.\n' >&2
  exit 1
fi
revision_suffix="${revision_suffix:0:max_suffix_length}"
revision_suffix="${revision_suffix%-}"
if [[ -z "${revision_suffix}" ]]; then
  printf 'The generated revision suffix is empty.\n' >&2
  exit 1
fi

if [[ "${app_revision_mode}" != "Multiple" ]]; then
  az containerapp revision set-mode \
    --name "${ORBIT_AZURE_CONTAINER_APP}" \
    --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
    --mode multiple \
    "${subscription_args[@]}" \
    --only-show-errors \
    --output none
fi

az containerapp update \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --image "${image}" \
  --revision-suffix "${revision_suffix}" \
  --set-env-vars \
    ORBIT_RUNTIME_PROFILE=production \
    ORBIT_AGENT_BACKEND=azure_openai \
    AZURE_OPENAI_MODEL="${deployment_model}" \
    AZURE_OPENAI_BASE_MODEL="${canonical_model}" \
    ORBIT_CORS_ORIGINS="${ORBIT_CORS_ORIGINS}" \
  "${subscription_args[@]}" \
  --only-show-errors \
  --output none

candidate_revision="$(az containerapp revision list \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  "${subscription_args[@]}" \
  --query "[?properties.template.containers[0].image=='${image}'].name | [-1]" \
  --output tsv)"
if [[ -z "${candidate_revision}" ]]; then
  printf 'The candidate revision could not be identified.\n' >&2
  exit 1
fi

# Keep the known-good revision serving while the candidate is inspected.
az containerapp ingress traffic set \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --revision-weight "${previous_revision}=100" "${candidate_revision}=0" \
  "${subscription_args[@]}" \
  --only-show-errors \
  --output none

IFS='|' read -r candidate_state candidate_health candidate_profile candidate_backend candidate_deployment candidate_base <<< "$(az containerapp revision show \
  --name "${ORBIT_AZURE_CONTAINER_APP}" \
  --resource-group "${ORBIT_AZURE_RESOURCE_GROUP}" \
  --revision "${candidate_revision}" \
  "${subscription_args[@]}" \
  --query "join('|',[properties.runningState,properties.healthState,properties.template.containers[0].env[?name=='ORBIT_RUNTIME_PROFILE'].value | [0],properties.template.containers[0].env[?name=='ORBIT_AGENT_BACKEND'].value | [0],properties.template.containers[0].env[?name=='AZURE_OPENAI_MODEL'].value | [0],properties.template.containers[0].env[?name=='AZURE_OPENAI_BASE_MODEL'].value | [0]])" \
  --output tsv)"
if [[ "${candidate_state}" != "Running" && "${candidate_state}" != "RunningAtMaxScale" && "${candidate_state}" != "ScaledToZero" || "${candidate_health}" != "Healthy" || \
  "${candidate_profile}" != "production" || "${candidate_backend}" != "azure_openai" || \
  "${candidate_deployment}" != "${deployment_model}" || "${candidate_base}" != "${canonical_model}" ]]; then
  printf 'Candidate revision is not Healthy or has an unexpected canonical model profile.\n' >&2
  exit 1
fi

printf 'Created Healthy candidate revision %s at 0%% traffic; prior revision %s remains at 100%%.\n' \
  "${candidate_revision}" "${previous_revision}"
