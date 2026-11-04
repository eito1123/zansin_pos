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

## コードを読むときの注意

会期中に機能を足しながら作ったため、次のような「読み違えやすい点」が残っています。コードを参考にする・直すときは、先にここを確認してください。

### CSS は後ろの指定が優先される
`style.css` は、機能を追加するたびに末尾へ上書きの指定を足しています。次のセレクタは、ファイル内に**2〜3か所**指定があり、後ろにある指定が効きます。前の方だけを直しても見た目が変わらない場合は、同じセレクタをファイル全体で検索してください。

`h1` `h2` `th` `td` `footer`（3か所） `#message` `.brand` `.brand strong` `.actions` `.received-display>span` `.coupon-row` `.coupon-note` `.coupon-detail`

ほかに、画面サイズごとの `@media` と、印刷用の `@media print` でも上書きしています。

### 使っていない古い仕組み
次のものはデータベースやコードに残っていますが、**今のアプリは使っていません**。現役の機能と思って手を入れないでください。

| 残っているもの | 状態 |
|---|---|
| テーブル `pos_backup_settings`、RPC `pos_backup_price` | 旧版の価格バックアップ。価格は端末ごとのローカル設定になり、送らなくなった |
| RPC `pos_backup_order` の7引数版 | クーポン対応前の旧版アプリ用。今のアプリは9引数版を使う |
| `db.js` の `openDatabase()` にある `queue` / `revision` の削除処理 | 旧版の価格送信の待ち行列を片付けるための移行処理 |
| `orderDiscount()` が `couponDiscount` のない売上を50円とみなす処理 | 割引額を設定できるようにする前に保存した売上のため |
| IndexedDB 名 `festival-yakitori-pos`、`sw.js` の `yakitori-pos-` | 初期の名前。変えると端末内の既存データが見えなくなるので、そのままにしている |

### 売上の項目名の対応
端末内（IndexedDB）とクラウド（Supabase）で、同じ項目の名前が違います。変換は `api/cloud.js`（送信）、`db.js` の `restoreBackup()`（復元）、`dashboard.js`（集計）に分かれています。項目を足すときは、すべての箇所を直してください。

| 意味 | 端末内（`orders`） | クラウド（`pos_backup_orders`） | RPC の引数 |
|---|---|---|---|
| 売上のID | `backupId`（UUID） | `order_id` | `p_order_id` |
| 端末内の連番 | `id` / `sourceLocalId` | `source_local_id` | `p_source_local_id` |
| 会計した端末 | `sourceDeviceId` | `source_device_id` | `p_source_device_id` |
| 会計時刻 | `date`（Unix ミリ秒） | `ordered_at_ms` | `p_ordered_at_ms` |
| 単価 | `unitPrice` | `unit_price` | `p_unit_price` |
| セット数 | `quantity` | `quantity` | `p_quantity` |
| 適用クーポン枚数 | `couponCount` | `coupon_count` | `p_coupon_count` |
| 1枚あたりの割引額 | `couponDiscount` | `coupon_discount` | `p_coupon_discount` |
| 金額 | `amount`（端末で計算） | `amount`（データベースの生成列） | なし（送らない） |
| 有効／取消 | `isActive` | `is_active` | `p_is_active` |
| 送信管理 | `version` / `syncedVersion` | なし | なし |
| 所有者・受信時刻 | なし | `owner_id` / `backed_up_at` / `updated_at` | なし（サーバーが付ける） |

`logic.js` の `orderDiscount()` は、両方の形（`couponCount` と `coupon_count`）を受け付けます。

### 上限値が複数の場所にある
| 値 | 場所 |
|---|---|
| 数量 1〜999 | `logic.js`（`makeOrder`）、テンキーの桁数（`app.js`）、データベースの制約 |
| 価格 1〜999,999円 | `logic.js`、`app.js`（価格設定）、データベースの制約 |
| クーポン 0〜99枚、割引額 1円〜単価 | `logic.js`（`MAX_COUPONS`・`validDiscount`）、データベースの制約 |
| 送信の間隔 約60秒、通信なしの判定 10分 | `cloud.js`、`dashboard.js`（`STALE_MS`） |
| ログインの有効期間 30日、取得件数 500件ずつ | `api/cloud.js` |

### 古いままのテスト
- `supabase/tests/backup.sql` は、クーポン対応前の内容です（7引数版の RPC と、旧版の価格 RPC を確認するもの）。クーポンの列は確認していません。
- `tests/update.cjs` は、テスト用サーバーの配信ファイルに集計ページ（`dashboard.html` / `dashboard.js`）を含めていません。
- 今の仕様の例は、`tests/logic.test.mjs`（金額・クーポン）と `tests/cloud-api.test.mjs`（API）が一番正確です。

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
