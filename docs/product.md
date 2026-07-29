# SIT ORBIT Product Brief

## Product definition

SIT ORBITは、芝浦工業大学で生じる授業・研究・課外活動を横断し、学生一人ひとりに「次の一手」を提案するPersonal Campus Agentである。

単なる情報集約や汎用チャットではなく、現実のイベントから行動を提案し、実行結果を将来利用できる証跡として残す。

## Core loop

```text
イベントを観測する
    ↓
関係する証跡を選ぶ
    ↓
実行可能な行動を一つ提案する
    ↓
学生が承認・変更・却下する
    ↓
完了結果を新しいイベントとして残す
```

## Foundation scenario

B1の学生が大宮キャンパスへ到着する。

次の授業まで18分あり、翌日締切の微分積分学課題と直近の誤答履歴が存在する。

SIT ORBITは、合成関数の微分を2問確認する12分間の行動を提案する。

学生が承認して完了した場合、その結果を`action_completed`イベントとして記録する。

このシナリオはすべて合成データで再現する。

## Non-goals for the foundation

- ScombZ、SIT Portfolio、My Libraryへの実接続
- 大学認証情報の取得・保存
- 課題や応募書類の自動提出
- 成績や技能の公式認定
- 常時位置追跡
- 複数Agentによる自律実行
- B1からB4までのLearner Twinの完成

## Product language

- Product name: `SIT ORBIT`
- Main message: `Two Campuses. Four Years. One Orbit.`
- Japanese message: `点だった今日が、未来の軌道になる。`
- Daily action: `Next Vector`
- Trace and context display: `Telemetry`
