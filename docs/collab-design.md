# AI合同会社 (AMONE) 共通連携: 最小設計 (sandbox)

COLLAB-005 の最初のPR。COLLAB-006 (v1.3, 11/9の相談) のうち、このPRの範囲に入るものを反映。
合成データのみ。本番・Secrets・課金・設定には触れない。

## 役割 (v1.3)
- よしひろ: 最終判断。モネ: 開発・テスト・PR・窓口。Codex: PRの独立レビュー。
- アムChat: 調査・設計・相談・頼まれたレビュー。Work: 画面操作が必須のときだけ。
- GitHub Actions: 自動の検証と、承認済みの反映。
- Chatを GitHub の出来事から人手なしで起こす方法は **未実証** (`UNSUPPORTED` のまま)。

## 構成
- **登録台帳** `collab/registry.example.json`: repo、窓口、許可レーン、許可操作、承認が要る操作 (`approvalRequired`)、通知先、優先度。新しいプロジェクトは1件足すだけ。
- **ルーター** `src/router.js` (純粋関数、GitHubには触らない)
  - `parseRequest`: `[MONE-REQUEST] id=<ID> lane=<chat|work|codex|mone> op=<操作> status=open|cancel sha=<SHA>` を読む。既存の書式を使い、新しいID体系は作らない。
  - `decide`: `route / reject / cancel / skip-duplicate / skip-cancelled / needs-approval` を返す。
  - `guardSideEffect`: コメント投稿・書き込み・反映の **直前** に、取消・投稿済み・SHAのずれをもう一度確かめる。
- **状態**: 依頼の鍵は `repo#Issue/PR番号#依頼ID`。別repoや別Issueの同じIDとはぶつからない。正本はGitHub。

## 守ること
- 取消が最優先。振り分け済みの依頼でも取消できる。取消済みの依頼は動かさない。
- 同じコメントID・同じ依頼は二度動かさない。
- 知らない `status` や、`op` のない依頼は拒否する (安全側)。
- 承認が要るかは **登録台帳と操作の中身** で決める。コメントに「承認済み」と書いてあっても承認とみなさない。課金・本番・Secrets・権限は必ず止めて聞く。
- 公開されるログに、秘密・非公開のURL/ID・個人情報・環境変数・APIの応答を出さない。

## 当面の頻度 (アカウント停止からの復旧後、暫定)
- 新しいPRは 1リポジトリで原則1日1件。結果コメントは原則1依頼1件。
- 同じSHAのCI再実行は原則1回まで。連続の自動再試行や、たまった依頼の一斉処理はしない。
- これはGitHubの公式な上限ではなく、自分たちで決めた控えめな目安。

## 検証状況 (別々に記録)
| 項目 | 状況 |
|---|---|
| ルーター・重複・取消・承認・SHAガードの単体テスト | このPRで確認 (`npm test`) |
| Codexレビュー | 未確認 |
| Chat回答 | Issue #13 で別途 |
| Work | 使っていない |
| GitHubの出来事でChatを即時起動 | **未実現・未実証** |

単体テストが通ることと、GitHub上で実際に連携できることは別。後者はまだ試していない。

## 決まっていないこと (このPRでは決めない)
1. 自動Mergeを続けるか、よしひろのMerge 1タップに揃えるか。決まるまで自動Mergeは標準にしない。
2. 非公開リポジトリの無料プランで、ブランチ保護や必須チェックがどこまで効くか。効かなければ自動反映しない。
3. 本番ではない「試験用の反映先」をどこに置くか。
4. GitHub Supportの案内に基づく、自動化の安全な条件。
5. Chatを即時に起こす公式の方法。
6. MagicPath・PostHog は任意の補助。このPRの必須にはしない。

## 次の段階 (別PR)
GitHub Actions の `concurrency` / `cancel-in-progress` と PR head SHA を使い、受付 → `decide` → 副作用の直前に `guardSideEffect` の流れを、sandboxで少量だけ試す。標準機能でできることを優先し、ルーターを作り込みすぎない。
