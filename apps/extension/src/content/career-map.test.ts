import { describe, expect, it } from "vitest";
import { buildCareerMapModel, createCareerMapOptions } from "./career-map";

describe("career map", () => {
  it("connects courses, technology, occupations, companies, and opportunities", () => {
    const model = buildCareerMapModel({
      courses: [
        {
          id: "course-control",
          name: "制御工学",
          technical_domains: ["モーション制御"],
          occupations: ["組込み開発"],
        },
      ],
      opportunities: [
        {
          schema_version: "v1",
          kind: "job",
          opportunities: [
            {
              kind: "job",
              local_id: "job:ABC-1",
              company_name: "Example Robotics",
              industry: ["ロボティクス"],
              status: "open",
              received_date: "2026-04-01",
              application_deadline: "2026-09-30",
              description: "制御と組込み開発",
              occupations: ["組込み開発"],
              locations: ["豊洲"],
              eligible_programs: ["機械系"],
              target_grades: [],
              period_start: null,
              period_end: null,
              duration: [],
              application_methods: [],
              relations: {
                job_offer: true,
                company_session: false,
                internship: false,
                hiring_record: false,
                alumni_directory: false,
                career_supporter: false,
                entrance_exam: false,
              },
            },
          ],
        },
      ],
    });
    const nodes = model.elements.filter((element) => element.group === "nodes");
    const edges = model.elements.filter((element) => element.group === "edges");
    expect(nodes.map((element) => element.data.kind)).toEqual(
      expect.arrayContaining([
        "course",
        "technical_domain",
        "occupation",
        "company",
        "opportunity",
      ]),
    );
    expect(edges.map((element) => element.data.relation)).toEqual(
      expect.arrayContaining(["uses", "leads_to", "offers"]),
    );
    const nodeIds = new Set(nodes.map((element) => element.data.id));
    for (const relationship of edges) {
      expect(nodeIds.has(relationship.data.source)).toBe(true);
      expect(nodeIds.has(relationship.data.target)).toBe(true);
    }
  });

  it("hides aggregate paths below five and never creates personal nodes", () => {
    const model = buildCareerMapModel({
      aggregate_paths: [
        {
          id: "path-small",
          label: "小規模な進路集計",
          count: 4,
          occupation: "研究開発",
        },
        {
          id: "path-valid",
          label: "ロボティクス進路",
          count: 5,
          technical_domain: "ロボティクス",
          occupation: "研究開発",
        },
      ],
    });
    expect(model.hidden_aggregate_count).toBe(1);
    expect(model.personal_node_count).toBe(0);
    expect(
      model.elements.some(
        (element) =>
          element.group === "nodes" &&
          element.data.label === "小規模な進路集計",
      ),
    ).toBe(false);
    expect(
      model.elements.some(
        (element) =>
          element.group === "nodes" &&
          element.data.label === "ロボティクス進路",
      ),
    ).toBe(true);
  });

  it("does not copy person names, company codes, or raw report URLs from history", () => {
    const model = buildCareerMapModel({
      histories: [
        {
          schema_version: "v1",
          company_name: "Example Robotics",
          company_code: "999999",
          hiring_records: [
            {
              local_id: "employment:999999:0",
              graduation_date: "2024-03-01",
              academic_field: "機械",
              department: "機械工学科",
              advisor_or_person: "山田 太郎",
              employment_type: "正社員",
              job_type: "研究開発",
              person_index: 0,
            },
          ],
          selection_reports: [
            {
              local_id: "exam:999999:0",
              graduation_date: "2024-03-01",
              academic_field: "機械",
              department: "機械工学科",
              gender: "",
              application_method: "自由応募",
              job_type: "研究開発",
              has_reference_es: true,
              report_href: "https://example.com/report?token=private",
              person_index: 0,
            },
          ],
          people: [
            {
              name: "山田 太郎",
              source_identifier: "person-1",
              role: "alumni",
              graduation_year: 2024,
              company: "Example Robotics",
              technical_domains: [],
              job_types: [],
            },
          ],
          obog_available: true,
        },
      ],
    });
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("山田 太郎");
    expect(serialized).not.toContain("999999");
    expect(serialized).not.toContain("token=private");
  });

  it("returns Cytoscape options for an interactive full-screen mount", () => {
    const model = buildCareerMapModel({});
    const options = createCareerMapOptions(model);
    expect(options.layout).toMatchObject({ name: "cose", animate: false });
    expect(options.style).toBeDefined();
    expect(options.minZoom).toBeGreaterThan(0);
    expect(options.maxZoom).toBeGreaterThan(options.minZoom ?? 0);
  });

  it("does not create orphan nodes or edges when a source value is empty", () => {
    const model = buildCareerMapModel({
      opportunities: [
        {
          schema_version: "v1",
          kind: "job",
          opportunities: [
            {
              kind: "job",
              local_id: "job:empty-company",
              company_name: "",
              industry: ["制御"],
              status: "unknown",
              received_date: null,
              application_deadline: null,
              description: null,
              occupations: ["研究開発"],
              locations: [],
              eligible_programs: [],
              target_grades: [],
              period_start: null,
              period_end: null,
              duration: [],
              application_methods: [],
              relations: {
                job_offer: true,
                company_session: false,
                internship: false,
                hiring_record: false,
                alumni_directory: false,
                career_supporter: false,
                entrance_exam: false,
              },
            },
          ],
        },
      ],
    });
    expect(model.elements).toEqual([]);
  });
});
