import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  ChatRunResponse,
  EvidenceLink,
  LibraryBibliographicRecord,
  RelatedBookCandidate,
} from "../api/client";
import type { ChatConversation } from "./chat-history";
import {
  ContextEvidenceConflictError,
  loadConversation,
  mergeCompletedChatContext,
  mergeConversationEvidence,
  mergeLibraryContext,
  mergeRelatedBookContext,
  newConversation,
  saveConversation,
  toChatContextManifest,
  toChatHistory,
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
  it("round-trips the shared completed-response fixture without duplicate evidence", () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../packages/api-client/fixtures/chat_context_roundtrip.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as {
      completed_response: Extract<ChatRunResponse, { status: "completed" }>;
      next_request: {
        context_manifest: { evidence: EvidenceLink[] };
      };
    };
    const response = fixture.completed_response;
    const merged = mergeCompletedChatContext(
      newConversation(),
      response.context_manifest,
      {
        evidence: response.message.evidence,
        relatedBooks: response.message.related_books,
      },
    );
    const manifest = toChatContextManifest(merged.contextManifest);
    const manifestEvidence = manifest.evidence ?? [];
    expect(manifestEvidence).toEqual(
      fixture.next_request.context_manifest.evidence,
    );
    expect(new Set(manifestEvidence.map((item) => item.evidence_id)).size).toBe(
      manifestEvidence.length,
    );
  });

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
  it("deduplicates mirrored completion evidence in stable order", () => {
    const conversation = newConversation();
    const assistant = {
      evidence: [evidence],
      relatedBooks: [],
    };
    const merged = mergeCompletedChatContext(
      conversation,
      {
        schema_version: "v1",
        evidence: [evidence],
        library_records: [],
        related_books: [],
      },
      assistant,
    );
    expect(merged.contextManifest.evidence).toEqual([evidence]);
    expect(toChatContextManifest(merged.contextManifest).evidence).toHaveLength(
      1,
    );
  });

  it("retains only opaque SCombZ personal evidence for same-conversation context", () => {
    const personal: EvidenceLink = {
      evidence_id: "scombz-course-list-v1-1234567890abcdef",
      title: "SCombZの履修科目",
      source_type: "scombz",
      locator: "orbit-scombz://read/1234567890abcdef",
      data_classification: "personal",
    };
    let conversation = mergeConversationEvidence(newConversation(), [personal]);
    expect(conversation.contextManifest.evidence).toEqual([personal]);

    conversation = mergeConversationEvidence(conversation, [
      {
        ...personal,
        locator: "orbit-scombz://read/1234567890abcdef?internal=secret",
      },
    ]);
    expect(conversation.contextManifest.evidence).toEqual([personal]);
  });

  it("repairs duplicate evidence retained in an older assistant message", async () => {
    const conversation = newConversation();
    await saveConversation({
      ...conversation,
      messages: [
        {
          id: "assistant-legacy",
          role: "assistant",
          content: "参照しました。",
          evidence: [evidence, { ...evidence }],
        },
      ],
    });
    const loaded = await loadConversation(conversation.conversationId);
    expect(loaded?.messages[0]?.evidence).toEqual([evidence]);
  });

  it("fails closed when mirrored evidence metadata conflicts", () => {
    expect(() =>
      mergeCompletedChatContext(
        newConversation(),
        {
          schema_version: "v1",
          evidence: [{ ...evidence, title: "別の書誌" }],
          library_records: [],
          related_books: [],
        },
        { evidence: [evidence], relatedBooks: [] },
      ),
    ).toThrow(ContextEvidenceConflictError);
  });

  it("accepts a twelve-thousand-character assistant history entry", () => {
    const history = toChatHistory([
      {
        id: "assistant-long",
        role: "assistant",
        content: "x".repeat(12_000),
      },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toHaveLength(12_000);
  });

  it("keeps legacy conversations local-only when processing metadata is absent", async () => {
    const legacy = { ...newConversation() } as unknown as Record<
      string,
      unknown
    >;
    delete legacy.processing_scope;
    delete legacy.provider_destination;
    delete legacy.history_eligible;
    await saveConversation(legacy as unknown as ChatConversation);
    const loaded = await loadConversation(legacy.conversationId as string);
    expect(loaded?.history_eligible).toBe(false);
    expect(loaded?.provider_destination).toBe("none");
    expect(loaded?.processing_scope).toBe("none");
  });
});
