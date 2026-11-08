# AI合同会社 共通連携: 最小設計 (sandbox)

COLLAB-005 の最初のPR。合成データのみ。本番・Secrets・課金には触れない。

## 構成
- **登録台帳** `collab/registry.example.json`: repo、窓口、許可レーン、許可操作、通知先、優先度。新規プロジェクトは1行足すだけ。
- **ルーター** `src/router.js`: 純粋関数。`[MONE-REQUEST] id=<ID> lane=<chat|work|codex|mone> op=<操作> sha=<SHA> status=open|cancel flags=<paid,production,secrets,permissions>` を読み、`route / reject / cancel / skip-duplicate / skip-cancelled / needs-approval` を返す。
- **状態**: 依頼ID→{state, commentIds}。正本はGitHub(コメント)。ルーターは台帳を受け取り、新しい台帳を返すだけ。

## 守ること
- 同じコメントIDや同じ依頼IDは二重に動かさない。取消した依頼は動かさない。
- 課金・本番・Secrets・権限は `needs-approval` で止めて、よしひろさんに聞く。
- Workは、登録で許可したプロジェクトのGUI作業だけ。

## 検証状況(別々に記録)
| 項目 | 状況 |
|---|---|
| ルーティング・重複・取消の単体テスト | このPRで確認 (`npm test`) |
| Codexレビュー | PR作成後に確認(未確認) |
| Chat回答 | Issue #13 への [MONE-REPLY] で別途 |
| Work | 使っていない |
| GitHubイベントでChatを即時起動 | **未実現・未実証**(存在を仮定しない) |

## 次の段階(別PR)
issue_comment を受ける無料のActions(受付→ルーター→状態の記録のみ)。Chat起動口が公式に確認できるまで `UNSUPPORTED` と記録して止める。
