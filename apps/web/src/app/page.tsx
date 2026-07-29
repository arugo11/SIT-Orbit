import { formatActionDuration } from "@/lib/format";

const evidence = [
  "微分積分学の課題は明日締切",
  "合成関数の微分で直近2回誤答",
  "次の授業まで18分利用可能",
];

export default function Home() {
  return (
    <main>
      <nav>
        <span className="wordmark">{"SIT//ORBIT"}</span>
        <span className="status">MISSION CONTROL · OMIYA</span>
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

        <article className="action-card">
          <div className="card-header">
            <span>NEXT VECTOR</span>
            <span>{formatActionDuration(12)}</span>
          </div>
          <h2>合成関数の微分を2問確認する</h2>
          <p>
            明日の課題に必要な内容で直近の誤答があり、次の授業までに完了できるためです。
          </p>
          <ul>
            {evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="actions">
            <button type="button">この行動を開始</button>
            <button className="secondary" type="button">
              理由を見る
            </button>
          </div>
        </article>
      </section>

      <footer>
        <span>OBSERVE · REASON · BRIDGE · INTERVENE · TRACE</span>
        <span>AI INNOVATORS CUP 2026</span>
      </footer>
    </main>
  );
}
