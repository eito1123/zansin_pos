# AGENTS.md — Zansin学祭POS 開発ガイド

学祭の焼き鳥屋台で使う、iPad 向けの簡易 POS（Web アプリ）です。このファイルは、AI エージェントと開発者が作業前に読むためのガイドです。
利用者向けの説明は [README.md](README.md)、クラウド（Supabase）の詳細は [supabase/README.md](supabase/README.md) にあります。
[docs/mvp-spec.md](docs/mvp-spec.md) は開発開始時の MVP 仕様書（歴史資料）です。**現在の仕様とは異なる**ので、作業の根拠にしないでください。

## 構成

```
iPad（Safari / ホーム画面アプリ）
 ├ POS 画面（index.html + app.js）── IndexedDB（売上・価格・割引額を端末内に保存）
 │                                      └ 未送信分を自動でバックアップ
 └ 全端末の集計（dashboard.html + dashboard.js）
            │ fetch('/api/cloud')
            ▼
Vercel Functions（api/cloud.js）── 共通パスワードでログイン、暗号化 Cookie でセッション保持
            │ REST / RPC
            ▼
Supabase（Postgres + Auth）── 全端末の売上バックアップ（読み取りは RLS、書き込みは RPC のみ）
```

| ファイル | 役割 |
|---|---|
| `index.html` / `app.js` | POS 画面（数量入力・会計・売上履歴・バックアップ・価格設定・割引設定） |
| `logic.js` | 金額計算・クーポン適用・入力処理などの純粋関数。ブラウザと API の両方から使う |
| `db.js` | IndexedDB（DB 名 `festival-yakitori-pos`、ストア `orders` / `settings`） |
| `cloud.js` | バックアップの送信・ログイン・復元（ブラウザ側） |
| `dashboard.html` / `dashboard.js` | 全端末の集計ページ（閲覧専用、印刷 / PDF） |
| `api/cloud.js` | Vercel Function。Supabase への中継と認証。許可した操作（action）だけを受け付ける |
| `sw.js` | Service Worker（オフライン起動用のキャッシュ）。`build.mjs` がキャッシュ名を自動更新 |
| `style.css` | 全画面のスタイル（印刷用スタイルを含む） |
| `server.mjs` | ローカル開発用サーバー（`npm start`、http://localhost:4173） |
| `build.mjs` | 公開用ファイルを `dist/` にコピー（Vercel のビルドコマンド） |
| `supabase/migrations/*.sql` | データベース定義。**日付順にすべて**実行する |
| `tests/` | テスト（下記） |

## 守るべきルール

これらは会計の正しさに関わります。変更する場合は理由を明確にしてください。

- **会計は端末内の保存が成功してから完了にする。** クラウドの応答は待たない。保存に失敗したら会計完了にせず、入力を保持してエラーを表示する。
- **通信がなくても会計できること。** クラウドが使えない・未ログインでも、会計・履歴・取消・設定は動く。
- **売上は削除しない。** 取消は `isActive = false`（クラウドでは `is_active = false`）にするだけ。取消済みは履歴に残し、集計から除外する。
- **単価と割引額は会計時点の値を売上ごとに保存する。** 価格や割引額を変えても、過去の売上の金額は変わらない。
- **金額 = 単価 × セット数 − 割引額 × 適用クーポン枚数。** クーポンは 1 枚につき 1 セットまで（セット数を超えた分は適用しない）。割引額が単価を超える場合は適用しない。計算は `logic.js` に集約し、データベース側の生成列（`amount`）と一致させる。
- **価格と割引額は端末ごとのローカル設定。** クラウドには送らない（売上に含まれる会計時点の値だけを送る）。
- **二重会計を防ぐ。** 保存中は操作をロックする。クーポン付きの会計だけ確認画面を出す（確定ボタンは会計完了ボタンと同じ位置に置かない）。
- **端末内のデータを全削除する操作を、通常の画面に置かない。**
- **iPad 横画面・タッチ操作が前提。** ボタンは大きく、会計画面はスクロールなしで 1 画面に収める（1180×820 と 1024×768 で確認）。OS のキーボードは原則使わない（独自テンキー）。例外はログイン時の端末名とパスワード入力のみ。
- **画面の文言は日本語。** 金額は `¥1,500` のように 3 桁区切り（`logic.js` の `yen`）。

## データベース（Supabase）の変更

- 変更は `supabase/migrations/` に**新しいファイルを追加**する。実行済みのファイルは書き換えない。
- **本番の SQL を先に実行してから、アプリをデプロイする。** 逆にすると、SQL を実行するまでバックアップ送信が失敗する（会計は端末内に残り、あとで再送される）。
- RPC の引数を増やすときは、旧版のアプリが残っていても動くよう、古い引数の関数も残す（例：`pos_backup_order` は 7 引数版と 9 引数版がある）。
- `public` スキーマのテーブルは API から見える可能性がある。新しいテーブルには RLS と権限設定を必ず付ける。

## コマンド

```bash
npm start      # ローカルサーバー（http://localhost:4173）
npm test       # 単体テスト（logic.test.mjs）と API テスト（cloud-api.test.mjs）
npm run build  # dist/ を作る（Vercel が自動で実行）
```

ブラウザテスト（`tests/browser.cjs`、`tests/cloud-browser.cjs`、`tests/update.cjs`）は Playwright と Microsoft Edge を使います。Playwright の入った `node_modules` の場所を環境変数 `POS_NODE_MODULES` で指定し、`browser.cjs` と `cloud-browser.cjs` は `npm start` でサーバーを起動した状態で実行します。

ローカルで画面を確認するときは、Service Worker が古いファイルを返すことがあります。開発者ツールで Service Worker の登録とキャッシュを消してから再読み込みしてください（本番はビルドのたびにキャッシュ名が変わるので問題ありません）。

## デプロイと Git の注意

- GitHub の `master` に push すると、Vercel が**そのまま本番にデプロイ**します。試す変更は別ブランチに push し、Preview（テスト用 Supabase につないだ環境）で確認してから `master` に取り込む。
- Vercel の無料プランでは、プロジェクトのメンバー以外が作者・共同作者に含まれるコミットがデプロイされないことがある。**コミットメッセージに `Co-Authored-By:` 行を付けない。**
- 秘密情報（Supabase のキー、Cookie 用の鍵、共通パスワード）はコミットしない。Vercel の環境変数にだけ登録する（`.env.example` は値の形式の見本）。
- 売上データ（CSV / JSON / PDF）はリポジトリに入れない。
