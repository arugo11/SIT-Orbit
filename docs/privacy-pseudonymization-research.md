# 会話単位の仮名化とローカル復元

この文書は、SIT ORBITのSCombZ／CAST会話で個人情報を外部Agentへ渡す前に行う変換の根拠と実装境界を記録する。ここでいう処理は匿名化ではない。端末内に追加情報を保持し、条件がそろえば表示名を復元できるため、GDPR Article 4(5)の定義に近い「仮名化（pseudonymisation）」として扱う。

## 採用する境界

会話ごとにランダムなopaque tokenを発行し、Azureへ送るprovider projectionでは許可された型付きフィールドだけを置換・削除する。対応表は会話専用のAES-GCM鍵で暗号化し、暗号文をIndexedDB、鍵を`chrome.storage.session`へ分離する。新Chat、Service Worker再起動、30分の無操作、明示削除で対応表を破棄する。復元は同じ会話で発行済みの完全一致tokenを、Markdownの通常テキストだけに適用する。URL、citation URI、Evidence ID、コード、Tool引数、未知のtokenは復元しない。

この境界は、漏えいした対応表や自由記述の推測から再識別できないことを保証しない。したがって「完全匿名化」「再識別不能」とは表示せず、外部送信前のallowlist、漏えいスキャン、TTL、会話分離を組み合わせたデータ最小化として運用する。メール、電話、学籍番号、Cookie、CSRF、内部ID、query／fragment、未分類の自由記述は復元対象にもprovider projectionにも含めない。

## 先行研究・標準から得た判断

| 資料 | SIT ORBITへの含意 |
| --- | --- |
| [GDPR Article 4(5)](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX%3A32016R0679) | 追加情報を分離して個人へ再対応できる処理は仮名化であり、匿名化とは区別される。対応表を端末内へ隔離し、外部へ送らない。 |
| [NIST SP 800-188](https://csrc.nist.gov/pubs/sp/800/188/final) | マスキングだけではde-identificationの十分条件にならない。準識別子の一般化、データ型の制限、アクセス境界、再識別リスクの監査を併用する。 |
| [HaS](https://arxiv.org/abs/2309.03057) | ローカルで置換した識別子を文脈に応じて扱う設計の実例。SIT ORBITは再生成ではなく決定的token置換を選ぶ。 |
| [LOPSIDED](https://arxiv.org/abs/2510.27016) | ローカル置換・復元を推論経路から分離する考え方を参考にする。ただし外部LLMに復元能力を持たせない。 |
| [Yermilov et al.](https://aclanthology.org/2023.trustnlp-1.20/) | 仮名化後もutilityと個人情報推測のトレードオフが残る。回答品質だけでなく、置換漏れと推測的復元を評価する。 |
| [TAB](https://aclanthology.org/2022.cl-4.19/) | 名前を隠しても準識別子の組合せから推測できる。卒業年、地域、職種などは必要最小限の粒度へ一般化し、少人数の組合せを外部へ出さない。 |

## 実装上の選択

- 外部へ送る名前は、意味を持つ実在の偽名ではなく、会話固有の`[[ORBIT_PERSON_<random>]]` tokenとする。
- Typed Snapshotを先に作り、検出・置換・一般化・Schema検証・漏えいスキャンの順で処理する。任意文章を正規表現だけで安全に匿名化できるとはみなさない。
- 公開シラバスの担当教員名はpublic情報として維持できるが、SCombZ学生情報やCAST第三者情報は個人projectionとして扱う。
- `personal/scombz_student`は抽出済みPDF本文を含むAzure例外、`restricted/cast_career`は型付き仮名プロフィールだけを含むAzure例外とする。どちらも`ORBIT_AGENT_BACKEND=azure_openai`かつ`ORBIT_OBSERVABILITY=off`を満たす場合だけ広告する。
- provider向け履歴（`provider_content`）と端末表示（`display_content`）を分離する。同じconversationの追質問には前者だけを再送し、新Chatや分類不能なlegacy履歴は再送しない。

## 限界と監査項目

仮名化は、公開情報との照合、希少な授業・職種・地域の組合せ、回答本文の引用、利用者が自分で明かした情報による再識別を防がない。監査では、元の氏名・連絡先・学籍番号・内部ID・raw HTML・生PDF・対応表・鍵がAzure payload、Chat履歴、ログへ入っていないことをcanaryで確認する。未知tokenや予約prefixが入力された場合は推測せず警告し、復元せずtokenのまま表示する。

Oracleへの相談は実行したが、生成後のbrowser reattachが繰り返し失敗して本文を回収できなかったため、設計根拠には採用していない。本実装の判断は上記の一次資料・査読論文・コード上の型付き境界に限定する。
