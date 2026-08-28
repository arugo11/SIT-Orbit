# SCombZ Student Read Agent API シナリオ実行レポート

実行日: 2026-08-28（JST）  
実行環境: ローカル FastAPI、`ORBIT_AGENT_BACKEND=fixture`、`ORBIT_SCOMBZ_STUDENT_READ=fixture`、`ORBIT_OBSERVABILITY=off`  
API: `http://127.0.0.1:8765`  
送信方式: Chrome拡張が利用する `/v1/chat/runs` と `/v1/chat/runs/{run_id}/tool-results` を同じJSON契約で呼び出し

## 実行結果

| シナリオ | Tool呼び出し | 結果 | 確認内容 |
|---|---|---|---|
| 今学期の履修科目・時間割 | `scombz_course_list` | `known` → `completed` | 2026年前期「コンピュータグラフィックス」を回答 |
| ポータルのお知らせ・全体課題 | `scombz_portal_read` | `known` → `completed` | お知らせ「レポート提出について」を回答 |
| 授業の課題・締切 | `scombz_course_read` | `partial` → `completed` | レポート課題1、期限 `2026-09-10 23:59 (+09:00)`、一部取得を明示 |
| 教材PDFの関連箇所 | `scombz_material_search` | `known` → `completed` | 「講義資料 第1回」p.4の関連引用を回答 |
| 同一conversationの追質問 | `scombz_course_list` | `known` → `completed` | 同じ`conversation_id`で、追質問も同じTool契約で継続 |
| 新しいChatでの追質問 | Toolなし | `completed` | 旧会話の科目名を引き継がず、合成Agentの通常応答になった |
| SCombZ再認証が必要 | `scombz_course_read` | `unavailable` → `completed` | `scombz_login_required`を「未取得」として表示し、空成功に変換しなかった |
| 「課題を提出」「テスト開始」 | `scombz_course_read`のみ | `completed` | 書き込みToolは呼ばれず、submit/start相当のrequestは発生しなかった |

## 会話抜粋

### 1. 履修科目・時間割

ユーザー: 今学期の履修科目と時間割を確認して  
Agent（Tool要求）: `scombz_course_list(query=...)`  
Tool結果: `known`、1科目、完全取得  
Agent:

> SCombZの履修科目・時間割を確認しました。  
> - コンピュータグラフィックス（2026 / 前期）

### 2. 授業課題・締切（部分取得）

ユーザー: コンピュータグラフィックスの課題と締切を教えて  
Agent（Tool要求）: `scombz_course_read(course_refs=[opaque course_ref])`  
Tool結果: `partial`、課題sectionは取得済み、テストsectionは未要求、`next_cursor=page-2`  
Agent:

> SCombZの授業ページを確認しました。  
> - レポート課題1（期限: 2026-09-10T23:59:00+09:00）  
>   講義資料を参照して提出する。  
>  
> 一部のみ確認しました（1/1）。

### 3. 教材PDF検索

ユーザー: コンピュータグラフィックスの教材PDFでレポートに関係する内容を探して  
Agent（Tool要求）: `scombz_material_search(course_ref=opaque, query=...)`  
Tool結果: `known`、資料1件、p.4  
Agent:

> SCombZの教材PDFを確認しました。  
> - 講義資料 第1回 p.4: レポートでは座標変換の考え方を説明する。

### 4. 再認証が必要な場合

Tool結果: `status=unavailable`、`reason_code=scombz_login_required`  
Agent:

> SCombZの参照結果を取得できませんでした（scombz_login_required）。

## 自己監査

- 全シナリオでHTTP開始応答は200、Tool結果返却後もHTTP 200で`completed`へ遷移した。
- 新ToolのTool call IDとEvidence IDは呼び出しごとに異なり、同一Toolの再実行で取り違えなかった。
- `partial`、`unavailable`を完全成功や「0件」に変換しなかった。
- 新しい`conversation_id`には前の会話の科目情報を渡さなかった。
- 書き込み用Tool、提出、回答、出席登録、テスト開始のrequestは送信していない。
- 今回はfixture結果を使ったAPI閉ループ確認であり、認証済み実SCombZのDOM・PDF・Network captureを検証した結果ではない。

実装後の再確認として、教材PDF検索（`scombz_material_search`）と部分取得課題（`scombz_course_read`）を再度開始から完了まで実行し、いずれもHTTP 200で完了した。APIプロセスのログにもread-only Tool以外の呼び出しは記録されていない。
