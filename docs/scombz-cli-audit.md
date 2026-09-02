# SCombZ実認証監査をCLIから実行する

この手順では、SCombZのCookieやAgent APIのBearer tokenをCodexの端末へ取り出さない。認証済みタブを見られるのは監査buildのChrome拡張だけで、CLIは`127.0.0.1`の相互認証済みWebSocketへ自然言語の命令、進捗、伏せ字済み結果だけを送る。

通常配布buildでは監査bridgeを無効にしている。最初に一度だけ監査buildをChromeへ読み込み、以後のpreflight、source選択、複数ターン、シナリオ実行、レポート生成はパネルを開かずにCLIから行える。

## 一度だけ行う準備

1. 認証済みのSCombZタブを残したまま、リポジトリルートで監査buildを作る。

   ```bash
   pnpm --filter @sit-orbit/extension build:audit
   ```

   `apps/extension/dist/audit-bridge.json`にはbuildごとのランダムsecretが生成される。このファイルは`.gitignore`対象であり、コピー、表示、共有をしない。

2. Chromeの拡張機能管理画面で開発者モードを有効にし、`apps/extension/dist`を「パッケージ化されていない拡張機能」として読み込む。既存のSIT ORBIT拡張を監査buildへ読み替えるのはこの一度だけでよい。

3. SCombZタブでSIT ORBITの接続同意を一度だけ済ませる。同意がない場合、CLIは自動同意せず`consent_required`で停止する。同意記録には付与時刻だけが保存される。

## preflightと参照元

まず監査buildがbridgeへ接続し、配備APIのcapabilityが`azure_openai / off / live`であることを確認する。

```bash
pnpm audit:agent -- preflight
pnpm audit:agent -- sources
```

`sources`の`source_ref`は短命なopaque参照である。SCombZタブが複数ある場合は自動選択せず、監査対象を明示する。

監査bridgeはCLIへ返す`conversation_id`、`tool_call_id`、`evidence_id`を接続単位の`audit-*`別名へ置換する。拡張とAgent APIの実IDはbridge内のreceipt対応にだけ使い、CLI出力・レポートには残さない。

```bash
pnpm audit:agent -- chat \
  --source-ref 'orbit-source://<sourcesで表示された参照>' \
  --message '今学期に取っている授業を教えて'
```

source ref、tab ID、Cookie、内部の`idnumber`はレポートへ保存されない。タブを再読み込みする、閉じる、別のSCombZタブへ移る、Service Workerが再起動する、または30分操作しないと参照元は失効する。

## 多ターン会話

`--conversation`へ同じIDを渡すと、拡張側の`ChatRunner`が同じsource、仮名化済みprovider履歴、サーバー発行Evidenceを引き継ぐ。CLIへ返る会話IDは監査レポート生成時に別名化される。

```bash
CONVERSATION='audit-local-conversation-01'
SOURCE='orbit-source://<明示した参照>'
pnpm audit:agent -- chat --conversation "$CONVERSATION" --source-ref "$SOURCE" \
  --message '近いうちに締切のあるものはある？'
pnpm audit:agent -- chat --conversation "$CONVERSATION" --source-ref "$SOURCE" \
  --message '一番急ぐものの内容と根拠を教えて'
```

`run`はシナリオJSONのturnを順番に同じ会話へ送り、`new_chat: true`が付いたturnで対応表・履歴・source bindingを破棄して新しい会話を開始する。複数sourceがある場合は、全turnへ同じrefを適用するために`--source-ref`を指定できる。turn自身の`source_ref`がある場合はそちらを優先する。

各シナリオのturnを終えると、CLIは自動的に`clear`を送り、その会話のprovider履歴、仮名化対応表、SCombZ Handle、シラバス参照を破棄してから次のシナリオへ進む。

```bash
pnpm audit:agent -- run docs/scombz-agent-live-scenarios.json \
  --source-ref 'orbit-source://<明示した参照>'
```

監査レポートを更新する場合は次を実行する。

```bash
pnpm audit:scombz-live
```

複数の認証済みSCombZタブがある場合、`audit:scombz-live`へも選択済み参照を明示する。

```bash
ORBIT_AUDIT_SOURCE_REF='orbit-source://<sourcesで選択した参照>' pnpm audit:scombz-live
```

レポート内の会話、Tool call、Evidenceは、それぞれ`audit-conversation-N`、`audit-tool-call-N`、`audit-evidence-N`という監査用別名へ変換される。拡張とAPIの対応関係を追跡できる一方、配備側の生IDやUUIDを監査文書へ残さない。Tool結果の`X-Orbit-Tool-Call-Id`と`X-Orbit-Evidence-Id`が片方だけ届いた場合は、CLI側で成功扱いにせず契約エラーとして停止する。

未接続、capability不一致、再認証、source選択未完了は`BLOCKED`または`reauth_required`として記録される。一般Web検索、fixture、旧SCombZ Toolへの隠れfallbackは行わない。書き込み要求でも提出、回答、出席登録、テスト開始を実行せず、公式画面を本人が操作する案内で停止する。

## 監査終了後

監査buildを常用しない場合は、production artifactへ戻す。

```bash
pnpm --filter @sit-orbit/extension build
```

production buildには`audit-bridge.json`、監査secret、localhost接続コードを含めない。監査ログにCookie、token、CSRF、raw HTML、生PDF、PDF全文、内部IDが残っていないことを確認してから、Chromeの拡張機能をproduction artifactへ読み替える。
