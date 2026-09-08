"use client";

import {
  type ActionProposal,
  B1_OMIYA_CONTEXT,
  B1_OMIYA_EVENT,
  createFoundationClient,
  type EvidenceLink,
  FoundationApiError,
  isOrbitEvent,
  type OrbitEvent,
} from "@sit-orbit/api-client";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatActionDuration } from "@/lib/format";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_ORBIT_API_BASE_URL?.trim() || "http://localhost:8000";

type LoopStatus =
  | "idle"
  | "loading"
  | "proposed"
  | "approved"
  | "rejected"
  | "completing"
  | "completed"
  | "error";

function describeError(error: unknown): string {
  if (error instanceof FoundationApiError) return error.message;
  return "Agent APIとの通信に失敗しました。";
}

function isCompletionEvent(
  event: unknown,
  actionId: string,
): event is OrbitEvent {
  if (!isOrbitEvent(event)) return false;
  return (
    event.event_type === "action_completed" &&
    event.scenario_id === B1_OMIYA_EVENT.scenario_id &&
    event.campus === B1_OMIYA_EVENT.campus &&
    event.data_classification === "synthetic" &&
    event.payload?.action_id === actionId &&
    event.payload?.approved === true &&
    event.payload?.completed === true
  );
}

function EvidenceList({ evidence }: { evidence: EvidenceLink[] }) {
  return (
    <ul>
      {evidence.map((item) => (
        <li key={item.evidence_id}>
          <span>{item.title}</span>
          <details>
            <summary>根拠の詳細</summary>
            <small>
              {item.source_type} · {item.data_classification} · {item.locator}
            </small>
          </details>
        </li>
      ))}
    </ul>
  );
}

export default function Home() {
  const client = useMemo(() => createFoundationClient(API_BASE_URL), []);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const proposalRequestInFlight = useRef(false);
  const completionRequestInFlight = useRef(false);
  const [status, setStatus] = useState<LoopStatus>("idle");
  const [proposal, setProposal] = useState<ActionProposal | null>(null);
  const [durationDraft, setDurationDraft] = useState("");
  const [approvedDuration, setApprovedDuration] = useState<number | null>(null);
  const [completionEvent, setCompletionEvent] = useState<OrbitEvent | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [reasonVisible, setReasonVisible] = useState(true);

  const effectiveDuration =
    approvedDuration ?? proposal?.duration_minutes ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestProposal = async (): Promise<void> => {
    if (status === "loading" || proposalRequestInFlight.current) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    proposalRequestInFlight.current = true;
    setStatus("loading");
    setProposal(null);
    setCompletionEvent(null);
    setApprovedDuration(null);
    setDurationDraft("");
    setError(null);
    try {
      const nextProposal = await client.propose();
      if (!mountedRef.current || generationRef.current !== generation) {
        return;
      }
      if (nextProposal.duration_minutes > 18) {
        throw new Error("合成デモの所要時間が18分を超えています。");
      }
      setProposal(nextProposal);
      setDurationDraft(String(nextProposal.duration_minutes));
      setReasonVisible(true);
      setStatus("proposed");
    } catch (requestError) {
      if (!mountedRef.current || generationRef.current !== generation) {
        return;
      }
      setStatus("error");
      setError(describeError(requestError));
    } finally {
      if (generationRef.current === generation) {
        proposalRequestInFlight.current = false;
      }
    }
  };

  const approveProposal = (): void => {
    if (!proposal || status !== "proposed") return;
    const duration = Number(durationDraft);
    if (!Number.isInteger(duration) || duration < 1 || duration > 18) {
      setError("所要時間は1〜18分の整数で指定してください。");
      return;
    }
    setApprovedDuration(duration);
    setError(null);
    setStatus("approved");
  };

  const rejectProposal = (): void => {
    if (!proposal || status !== "proposed") return;
    setError(null);
    setApprovedDuration(null);
    setStatus("rejected");
  };

  const recordCompletion = async (): Promise<void> => {
    if (
      !proposal ||
      status !== "approved" ||
      approvedDuration === null ||
      completionRequestInFlight.current
    ) {
      return;
    }
    const generation = generationRef.current;
    completionRequestInFlight.current = true;
    setStatus("completing");
    setError(null);
    try {
      const durationNote =
        approvedDuration === proposal.duration_minutes
          ? "合成fixtureを完了"
          : `合成fixtureの所要時間を${approvedDuration}分へ変更して完了`;
      const event = await client.verify(proposal.action_id, {
        scenario_id: B1_OMIYA_EVENT.scenario_id,
        campus: B1_OMIYA_EVENT.campus,
        approved: true,
        completed: true,
        notes: durationNote,
      });
      if (!mountedRef.current || generationRef.current !== generation) {
        return;
      }
      if (!isCompletionEvent(event, proposal.action_id)) {
        throw new Error("確認済みの合成完了イベントを受け取れませんでした。");
      }
      setCompletionEvent(event);
      setStatus("completed");
    } catch (requestError) {
      if (!mountedRef.current || generationRef.current !== generation) {
        return;
      }
      setStatus("approved");
      setError(describeError(requestError));
    } finally {
      if (generationRef.current === generation) {
        completionRequestInFlight.current = false;
      }
    }
  };

  const resetLoop = (): void => {
    generationRef.current += 1;
    proposalRequestInFlight.current = false;
    completionRequestInFlight.current = false;
    setStatus("idle");
    setProposal(null);
    setDurationDraft("");
    setApprovedDuration(null);
    setCompletionEvent(null);
    setError(null);
    setReasonVisible(true);
  };

  const completedActionId =
    typeof completionEvent?.payload?.action_id === "string"
      ? completionEvent.payload.action_id
      : proposal?.action_id;

  return (
    <main>
      <nav>
        <span className="wordmark">{"SIT//ORBIT"}</span>
        <span className="status">合成デモ · 大宮</span>
      </nav>

      <section className="hero">
        <p className="eyebrow">TWO CAMPUSES. FOUR YEARS. ONE ORBIT.</p>
        <h1>
          点だった今日が、
          <br />
          <span>未来の軌道になる。</span>
        </h1>
        <p className="lead">
          芝浦工業大学で生じる学びと活動を、今の一手と将来の証拠へつなぐ
          Personal Campus Agent。
        </p>
      </section>

      <section className="mission">
        <div className="orbit-mark" aria-hidden="true">
          <div className="planet">SIT</div>
        </div>

        <article className="action-card" aria-live="polite">
          <div className="card-header">
            <span>NEXT VECTOR</span>
            <span>
              {effectiveDuration === null
                ? "B1 DEMO"
                : formatActionDuration(effectiveDuration)}
            </span>
          </div>

          {proposal ? (
            <>
              <h2>{proposal.title}</h2>
              {reasonVisible ? <p>{proposal.reason}</p> : null}
              <EvidenceList evidence={proposal.evidence} />

              {status === "proposed" ? (
                <div className="approval-controls">
                  <label className="duration-editor" htmlFor="duration">
                    所要時間（1〜18分）
                    <input
                      id="duration"
                      type="number"
                      min={1}
                      max={18}
                      step={1}
                      value={durationDraft}
                      onInput={(event) =>
                        setDurationDraft(event.currentTarget.value)
                      }
                      onChange={(event) => setDurationDraft(event.target.value)}
                    />
                  </label>
                  <div className="actions">
                    <button type="button" onClick={approveProposal}>
                      {durationDraft === String(proposal.duration_minutes)
                        ? "提案を承認する"
                        : "変更して承認する"}
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={rejectProposal}
                    >
                      提案を却下する
                    </button>
                  </div>
                </div>
              ) : null}

              {status === "approved" ||
              status === "completing" ||
              status === "completed" ? (
                <p className="state-message">
                  承認済み · 所要時間 {approvedDuration}分
                </p>
              ) : null}

              {status === "approved" || status === "completing" ? (
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => void recordCompletion()}
                    disabled={status === "completing"}
                  >
                    {status === "completing"
                      ? "完了を記録中…"
                      : "完了を確認して記録する"}
                  </button>
                </div>
              ) : null}

              {status === "rejected" ? (
                <p className="state-message">
                  提案を却下しました（APIには送信していません）。
                </p>
              ) : null}

              {status === "completed" && completionEvent ? (
                <section className="completion-event" aria-label="完了イベント">
                  <strong>完了イベント</strong>
                  <span>承認した行動を完了として記録しました。</span>
                  <details>
                    <summary>イベントの詳細</summary>
                    <small>
                      種類: {completionEvent.event_type} · event_id:{" "}
                      {completionEvent.event_id ?? "未指定"}
                      {completedActionId
                        ? ` · action_id: ${completedActionId}`
                        : ""}
                    </small>
                  </details>
                  <small>大学の公式記録ではない合成イベントです。</small>
                </section>
              ) : null}

              <div className="actions">
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setReasonVisible((visible) => !visible)}
                  aria-expanded={reasonVisible}
                >
                  {reasonVisible ? "理由を隠す" : "理由を見る"}
                </button>
                {status === "rejected" || status === "completed" ? (
                  <button
                    className="secondary"
                    type="button"
                    onClick={resetLoop}
                  >
                    最初に戻る
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <h2>根拠から次の一手を提案する</h2>
              <p>
                合成データで再現したB1大宮イベントです。提案を取得すると、Agent
                APIの応答と根拠を表示します。
              </p>
              <EvidenceList evidence={B1_OMIYA_CONTEXT} />
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void requestProposal()}
                  disabled={status === "loading"}
                >
                  {status === "loading" ? "提案を取得中…" : "提案を取得する"}
                </button>
                {status === "error" ? (
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => void requestProposal()}
                  >
                    再試行
                  </button>
                ) : null}
              </div>
            </>
          )}

          {error ? (
            <p className="error-message" role="alert">
              {error}
            </p>
          ) : null}
        </article>
      </section>

      <footer>
        <span>OBSERVE · REASON · BRIDGE · INTERVENE · TRACE</span>
        <span>AI INNOVATORS CUP 2026</span>
      </footer>
    </main>
  );
}
