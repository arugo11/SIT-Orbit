import { describe, expect, it } from "vitest";
import type {
  EvidenceLink,
  LibraryBibliographicRecord,
  RelatedBookCandidate,
} from "../api/client";
import {
  mergeConversationEvidence,
  mergeLibraryContext,
  mergeRelatedBookContext,
  newConversation,
  toChatContextManifest,
} from "./chat-history";

const evidence: EvidenceLink = {
  evidence_id: "library-catalog-search-v1-local",
  title: "公式OPAC",
  source_type: "library",
  locator: "orbit-library://public/local",
  data_classification: "public",
};

const record: LibraryBibliographicRecord = {
  resource_ref: "orbit-library://record/1234567890abcdef",
  title: "ロボット工学",
  authors: ["著者"],
  subjects: ["ロボット"],
  isbn: null,
  publisher: null,
  publication_year: 2020,
  format: "book",
  campus: "omiya",
  url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ABC",
  holdings: [
    {
      campus: "omiya",
      location: "大宮図書館 3階",
      call_number: "548.3/R1",
      status: "available",
      due_date: null,
      reservation_count: 0,
    },
  ],
  related_records: [],
};

const relatedBook: RelatedBookCandidate = {
  candidate_ref: "orbit-book://candidate/abcdef1234567890",
  title: "Robot Learning",
  authors: ["Jane Doe"],
  isbn: "9780000000001",
  publication_year: 2024,
  relation_axes: [{ label: "強化学習", source: "metadata" }],
  why_related: "ロボット制御への学習応用を扱う。",
  evidence_ids: [evidence.evidence_id],
  catalog_verification: { status: "unverified" },
  observed_at: "2026-08-24T00:00:00Z",
};

describe("chat context manifest", () => {
  it("keeps a public OPAC record across turns and adds completion evidence", () => {
    let conversation = newConversation();
    conversation = mergeLibraryContext(conversation, [record]);
    expect(conversation.contextManifest.library_records).toHaveLength(1);
    expect(
      toChatContextManifest(conversation.contextManifest).library_records?.[0]
        ?.record.resource_ref,
    ).toBe(record.resource_ref);

    conversation = mergeConversationEvidence(conversation, [evidence]);
    expect(conversation.contextManifest.evidence[0]?.evidence_id).toBe(
      evidence.evidence_id,
    );
    expect(
      conversation.contextManifest.library_records[0]?.evidence_ids,
    ).toContain(evidence.evidence_id);
  });

  it("drops unsafe URLs and raw page markers instead of persisting them", () => {
    let conversation = newConversation();
    conversation = mergeLibraryContext(conversation, [
      {
        ...record,
        title: "<script>prompt()</script>",
        url: `${record.url}?token=secret`,
      },
    ]);
    expect(conversation.contextManifest.library_records).toHaveLength(0);
  });

  it("persists only grounded public related-book candidates", () => {
    let conversation = newConversation();
    conversation = mergeRelatedBookContext(
      conversation,
      [relatedBook],
      [evidence],
    );

    expect(conversation.contextManifest.related_books).toHaveLength(1);
    expect(
      toChatContextManifest(conversation.contextManifest).related_books?.[0]
        ?.candidate_ref,
    ).toBe(relatedBook.candidate_ref);

    conversation = mergeRelatedBookContext(conversation, [
      {
        ...relatedBook,
        candidate_ref: "orbit-book://candidate/unsafeunsafeunsafe1",
        evidence_ids: ["unknown-evidence"],
      },
    ]);
    expect(conversation.contextManifest.related_books).toHaveLength(1);
  });
});
