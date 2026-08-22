import cytoscape from "cytoscape";
import type { CastHistoryLocalSnapshot } from "./cast-history-reports-reader";
import type {
  CastOpportunity,
  CastOpportunityLocalSnapshot,
} from "./cast-opportunities-reader";

export type CareerMapNodeKind =
  | "course"
  | "technical_domain"
  | "occupation"
  | "company"
  | "opportunity"
  | "career_path";

export type CareerMapRelation =
  | "uses"
  | "leads_to"
  | "employs"
  | "offers"
  | "aggregates";

export interface CareerMapCourse {
  id: string;
  name: string;
  technical_domains?: string[];
  occupations?: string[];
}

/** Public, non-personal aggregate supplied by an already-approved source. */
export interface CareerMapAggregatePath {
  id: string;
  label: string;
  count: number;
  technical_domain?: string;
  occupation?: string;
  company?: string;
}

export interface CareerMapInput {
  courses?: CareerMapCourse[];
  opportunities?: CastOpportunityLocalSnapshot[];
  histories?: CastHistoryLocalSnapshot[];
  aggregate_paths?: CareerMapAggregatePath[];
}

export interface CareerMapNodeData {
  id: string;
  label: string;
  kind: CareerMapNodeKind;
  count?: number;
}

export interface CareerMapEdgeData {
  id: string;
  source: string;
  target: string;
  relation: CareerMapRelation;
}

export type CareerMapElement =
  | { group: "nodes"; data: CareerMapNodeData; classes?: string }
  | { group: "edges"; data: CareerMapEdgeData; classes?: string };

export interface CareerMapModel {
  schema_version: "v1";
  elements: CareerMapElement[];
  hidden_aggregate_count: number;
  personal_node_count: 0;
}

const MIN_AGGREGATE_COUNT = 5;
const MAX_LABEL_LENGTH = 160;
const MAX_NODES = 1000;
const MAX_EDGES = 3000;

export const CAREER_MAP_STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "text-wrap": "wrap",
      "text-max-width": "140px",
      "font-size": "11px",
      "background-color": "#64748b",
      color: "#0f172a",
      "text-valign": "center",
      "text-halign": "center",
      width: 44,
      height: 44,
    },
  },
  {
    selector: 'node[kind = "course"]',
    style: { "background-color": "#0ea5e9", shape: "round-rectangle" },
  },
  {
    selector: 'node[kind = "technical_domain"]',
    style: { "background-color": "#8b5cf6", shape: "ellipse" },
  },
  {
    selector: 'node[kind = "occupation"]',
    style: { "background-color": "#f59e0b", shape: "round-rectangle" },
  },
  {
    selector: 'node[kind = "company"]',
    style: { "background-color": "#10b981", shape: "hexagon" },
  },
  {
    selector: 'node[kind = "opportunity"]',
    style: { "background-color": "#14b8a6", shape: "diamond" },
  },
  {
    selector: 'node[kind = "career_path"]',
    style: { "background-color": "#ec4899", shape: "star" },
  },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "#94a3b8",
      "target-arrow-color": "#94a3b8",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
    },
  },
];

function label(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\u3000\s]+/gu, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

function keyPart(value: string): string {
  return label(value)
    .toLocaleLowerCase("ja-JP")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function node(
  kind: CareerMapNodeKind,
  key: string,
  text: string,
  count?: number,
): CareerMapElement {
  return {
    group: "nodes",
    data: {
      id: `${kind}:${keyPart(key) || "unknown"}`,
      label: label(text) || "不明",
      kind,
      ...(count === undefined ? {} : { count }),
    },
  };
}

function edge(
  source: string,
  target: string,
  relation: CareerMapRelation,
  index: number,
): CareerMapElement {
  return {
    group: "edges",
    data: {
      id: `edge:${relation}:${index}`,
      source,
      target,
      relation,
    },
  };
}

function opportunityNodeId(opportunity: CastOpportunity): string {
  return `opportunity:${keyPart(`${opportunity.kind}-${opportunity.local_id}`)}`;
}

function addNode(
  elements: CareerMapElement[],
  seen: Set<string>,
  value: CareerMapElement,
): boolean {
  if (seen.size >= MAX_NODES) return false;
  if (value.group !== "nodes" || seen.has(value.data.id)) return false;
  seen.add(value.data.id);
  elements.push(value);
  return true;
}

function addEdge(
  elements: CareerMapElement[],
  edgeKeys: Set<string>,
  value: CareerMapElement,
): boolean {
  if (edgeKeys.size >= MAX_EDGES || value.group !== "edges") return false;
  const key = `${value.data.source}:${value.data.target}:${value.data.relation}`;
  if (edgeKeys.has(key)) return false;
  edgeKeys.add(key);
  elements.push(value);
  return true;
}

function addTermNodeAndEdge(
  elements: CareerMapElement[],
  seenNodes: Set<string>,
  seenEdges: Set<string>,
  sourceId: string,
  term: string,
  kind: "technical_domain" | "occupation",
  relation: CareerMapRelation,
  edgeIndex: { value: number },
): void {
  const text = label(term);
  if (!text) return;
  const target = `${kind}:${keyPart(text)}`;
  const targetAdded =
    seenNodes.has(target) ||
    addNode(elements, seenNodes, node(kind, text, text));
  if (!seenNodes.has(sourceId) || !targetAdded) return;
  if (
    addEdge(
      elements,
      seenEdges,
      edge(sourceId, target, relation, edgeIndex.value),
    )
  ) {
    edgeIndex.value += 1;
  }
}

function addOpportunity(
  elements: CareerMapElement[],
  seenNodes: Set<string>,
  seenEdges: Set<string>,
  opportunity: CastOpportunity,
  edgeIndex: { value: number },
): void {
  const company = label(opportunity.company_name);
  if (!company) return;
  const companyId = `company:${keyPart(company)}`;
  const opportunityId = opportunityNodeId(opportunity);
  addNode(elements, seenNodes, node("company", company, company));
  addNode(
    elements,
    seenNodes,
    node(
      "opportunity",
      `${opportunity.kind}-${opportunity.local_id}`,
      opportunity.kind === "job" ? "求人" : "インターン",
    ),
  );
  if (seenNodes.has(companyId) && seenNodes.has(opportunityId)) {
    if (
      addEdge(
        elements,
        seenEdges,
        edge(companyId, opportunityId, "offers", edgeIndex.value),
      )
    ) {
      edgeIndex.value += 1;
    }
  }
  for (const technical of [
    ...opportunity.industry,
    ...opportunity.eligible_programs,
  ]) {
    addTermNodeAndEdge(
      elements,
      seenNodes,
      seenEdges,
      opportunityId,
      technical,
      "technical_domain",
      "uses",
      edgeIndex,
    );
  }
  for (const occupation of opportunity.occupations) {
    addTermNodeAndEdge(
      elements,
      seenNodes,
      seenEdges,
      opportunityId,
      occupation,
      "occupation",
      "leads_to",
      edgeIndex,
    );
  }
}

export function buildCareerMapModel(input: CareerMapInput): CareerMapModel {
  const elements: CareerMapElement[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  const edgeIndex = { value: 0 };
  let hiddenAggregateCount = 0;

  for (const course of input.courses ?? []) {
    const courseName = label(course.name);
    if (!courseName) continue;
    const courseId = `course:${keyPart(course.id || courseName)}`;
    addNode(
      elements,
      seenNodes,
      node("course", course.id || courseName, courseName),
    );
    for (const technical of course.technical_domains ?? []) {
      addTermNodeAndEdge(
        elements,
        seenNodes,
        seenEdges,
        courseId,
        technical,
        "technical_domain",
        "uses",
        edgeIndex,
      );
    }
    for (const occupation of course.occupations ?? []) {
      addTermNodeAndEdge(
        elements,
        seenNodes,
        seenEdges,
        courseId,
        occupation,
        "occupation",
        "leads_to",
        edgeIndex,
      );
    }
  }

  for (const snapshot of input.opportunities ?? []) {
    for (const opportunity of snapshot.opportunities) {
      addOpportunity(elements, seenNodes, seenEdges, opportunity, edgeIndex);
    }
  }

  for (const history of input.histories ?? []) {
    const company = label(history.company_name);
    if (!company) continue;
    const companyId = `company:${keyPart(company)}`;
    addNode(elements, seenNodes, node("company", company, company));
    for (const record of history.hiring_records) {
      if (record.job_type) {
        addTermNodeAndEdge(
          elements,
          seenNodes,
          seenEdges,
          companyId,
          record.job_type,
          "occupation",
          "employs",
          edgeIndex,
        );
      }
      if (record.academic_field) {
        addTermNodeAndEdge(
          elements,
          seenNodes,
          seenEdges,
          companyId,
          record.academic_field,
          "technical_domain",
          "aggregates",
          edgeIndex,
        );
      }
    }
  }

  for (const aggregate of input.aggregate_paths ?? []) {
    const count = Number.isSafeInteger(aggregate.count) ? aggregate.count : 0;
    if (count < MIN_AGGREGATE_COUNT) {
      hiddenAggregateCount += 1;
      continue;
    }
    const aggregateLabel = label(aggregate.label);
    if (!aggregateLabel) continue;
    const aggregateId = `career_path:${keyPart(aggregate.id || aggregateLabel)}`;
    addNode(
      elements,
      seenNodes,
      node(
        "career_path",
        aggregate.id || aggregateLabel,
        aggregateLabel,
        count,
      ),
    );
    const targetTerms: Array<{
      value: string | undefined;
      kind: "technical_domain" | "occupation" | "company";
    }> = [
      { value: aggregate.technical_domain, kind: "technical_domain" },
      { value: aggregate.occupation, kind: "occupation" },
      { value: aggregate.company, kind: "company" },
    ];
    for (const targetTerm of targetTerms) {
      const text = label(targetTerm.value);
      if (!text) continue;
      const targetKind = targetTerm.kind;
      const targetId = `${targetKind}:${keyPart(text)}`;
      const targetAdded =
        seenNodes.has(targetId) ||
        addNode(elements, seenNodes, node(targetKind, text, text));
      if (!seenNodes.has(aggregateId) || !targetAdded) continue;
      if (
        addEdge(
          elements,
          seenEdges,
          edge(aggregateId, targetId, "aggregates", edgeIndex.value),
        )
      ) {
        edgeIndex.value += 1;
      }
    }
  }

  return {
    schema_version: "v1",
    elements,
    hidden_aggregate_count: hiddenAggregateCount,
    personal_node_count: 0,
  };
}

export function createCareerMapOptions(
  model: CareerMapModel,
): cytoscape.CytoscapeOptions {
  return {
    elements: model.elements,
    style: CAREER_MAP_STYLE,
    layout: {
      name: "cose",
      animate: false,
      fit: true,
      padding: 32,
    },
    minZoom: 0.25,
    maxZoom: 2.5,
    wheelSensitivity: 0.2,
  };
}

/** Mount the interactive graph in the full-screen workspace only. */
export function mountCareerMap(
  container: HTMLElement,
  model: CareerMapModel,
): cytoscape.Core {
  return cytoscape({
    ...createCareerMapOptions(model),
    container,
  });
}
