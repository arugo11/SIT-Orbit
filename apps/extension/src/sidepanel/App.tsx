import { useEffect, useState } from "react";
import type { PageContext, PageKind } from "../content/page-context";
import {
  isPageContext,
  isPageContextUpdatedMessage,
  MESSAGE_TYPES,
} from "../shared/messages";

const PAGE_KIND_LABEL: Record<PageKind, string> = {
  scombz: "ScombZページ",
  other: "その他",
};

const LOCAL_FIXTURE = {
  campus: "B1 大宮",
  event: "campus_entered",
  evidence: "微分積分学の課題は明日締切",
  available: "次の授業まで18分",
};

function requestPageContext(): Promise<PageContext | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.getPageContext },
      (response: unknown) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(isPageContext(response) ? response : null);
      },
    );
  });
}

export function App() {
  const [pageContext, setPageContext] = useState<PageContext | null>(null);

  useEffect(() => {
    let mounted = true;

    const handleMessage = (message: unknown) => {
      if (mounted && isPageContextUpdatedMessage(message)) {
        setPageContext(message.context);
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    void requestPageContext().then((context) => {
      if (mounted) {
        setPageContext(context);
      }
    });

    return () => {
      mounted = false;
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <div>
          <p className="eyebrow">SIT ORBIT</p>
          <h1>次の一歩を、軽く。</h1>
        </div>
        <span className="status-badge">ローカル表示</span>
      </header>

      <section className="context-card" aria-labelledby="page-context-title">
        <div className="section-heading">
          <h2 id="page-context-title">現在のScombZページ</h2>
          <span className="section-note">読み取りは最小限</span>
        </div>
        {pageContext ? (
          <dl className="context-list">
            <div>
              <dt>ページ種別</dt>
              <dd>{PAGE_KIND_LABEL[pageContext.kind]}</dd>
            </div>
            <div>
              <dt>タイトル</dt>
              <dd>{pageContext.title}</dd>
            </div>
            <div>
              <dt>URL</dt>
              <dd className="url-value">{pageContext.url}</dd>
            </div>
            {pageContext.scombz ? (
              <>
                <div>
                  <dt>ルート</dt>
                  <dd>{pageContext.scombz.route}</dd>
                </div>
                <div>
                  <dt>課題</dt>
                  <dd>{pageContext.scombz.tasks.length}件</dd>
                </div>
                <div>
                  <dt>お知らせ</dt>
                  <dd>{pageContext.scombz.announcements.length}件</dd>
                </div>
                <div>
                  <dt>関連リンク</dt>
                  <dd>{pageContext.scombz.relatedLinks.length}件</dd>
                </div>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="empty-state">ScombZページの情報を待っています。</p>
        )}
      </section>

      <section className="fixture-card" aria-labelledby="fixture-title">
        <div className="section-heading">
          <h2 id="fixture-title">B1 大宮のデモfixture</h2>
          <span className="fixture-label">合成データ</span>
        </div>
        <p className="fixture-disclaimer">
          これはローカルの静的表示です。Agent
          APIや大学の公式記録には接続していません。
        </p>
        <dl className="fixture-list">
          <div>
            <dt>場所</dt>
            <dd>{LOCAL_FIXTURE.campus}</dd>
          </div>
          <div>
            <dt>イベント</dt>
            <dd>{LOCAL_FIXTURE.event}</dd>
          </div>
          <div>
            <dt>根拠の例</dt>
            <dd>{LOCAL_FIXTURE.evidence}</dd>
          </div>
          <div>
            <dt>利用可能時間</dt>
            <dd>{LOCAL_FIXTURE.available}</dd>
          </div>
        </dl>
      </section>

      <p className="footer-note">
        この段階では提案の作成や外部サービスへの書き込みは行いません。
      </p>
    </main>
  );
}
