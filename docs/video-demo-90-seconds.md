# Chatのデモ手順（廃止）

Chatの自然文fixtureデモと固定台本は廃止した。Chat専用のfixtureや自然文からToolを選ぶローカル分類は存在しない。

開発・CIのfixture Chatは、入力にかかわらず次の一般回答だけを返す。

> fixtureでは一般的なTool選択を再現しません。Azure backendで確認が必要です。

したがって、このfixtureの出力をSCombZ、CAST、図書館、SITRUSの実連携結果として収録・提出してはならない。`ORBIT_RUNTIME_PROFILE=demo`はAction Agentの合成デモ専用で、ChatのTool呼び出しを有効にしない。

## Chatの受入経路

実際のChat確認は、既存のAzure for Students resourceで、canonical profile `gpt-5.6-terra`を使用するproduction buildだけを対象にする。毎ターン、extensionのauth-only preflight、APIが広告したclient Tool、認証・同意・privacy条件の交差をTool Catalogへ渡し、Azure Responses Hosted Tool Searchで発見されたToolだけを一件ずつ実行する。

最低限の合成確認は次の順で行う。

1. 「去年の情報工学科で卒業した人の就職先」から`cast_search`の条件が正しく組み立てられること。
2. 続く「それを仕事として体験するなら今参加できるもの」から募集中の`cast_search`へ会話が継続すること。
3. 「CASTとの連携機能では何ができる？」では`describe_available_capabilities`だけを使い、CAST実データを読まないこと。

Tool実行表示、検索条件、端末内詳細とAgent向け匿名集計の分離、Evidence付与を確認する。`reauth_required`、`form_changed`、Evidence欠落、privacy境界違反は成功扱いにしない。live acceptanceに失敗した場合はアプリ内fallbackを追加せず、直前のHealthy revisionへ戻す。

Azure操作は、明示されたAzure for Students subscription内の既存resourceに限定する。subscriptionのread-backができない場合、または既存resourceが`Succeeded`でない場合は実行を止める。
