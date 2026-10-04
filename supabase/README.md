# Supabaseバックアップの導入

バックアップとiPad交換時の復元専用です。端末間のリアルタイム同期は行いません。
共通パスワードだけを入力するログイン画面を実装しています。裏側では運営用のSupabase Authアカウントを使い、所有者IDを共通にします。端末は個別のUUIDと端末名で区別します。

## 初回設定（管理者）

1. SQL Editorで `migrations/202610040001_backup.sql`、次に `migrations/202610040002_devices.sql` を実行。001を実行済みなら002だけを実行してください。
2. SupabaseのAuthentication → Usersで運営用メールアドレスのユーザーを1名作成し、メール確認済みにして十分に長い共通パスワードを設定します。新規登録は無効にします。既存バックアップがある場合は同じユーザーを使い続けてください。
3. VercelのProject → Settings → Environment Variablesに以下を登録します（Production。検証時はPreviewにも登録）。

| 変数 | 値 |
|---|---|
| `SUPABASE_URL` | SupabaseプロジェクトのHTTPS URL |
| `SUPABASE_PUBLISHABLE_KEY` | Publishableキー、または旧anonキー。service_roleキーは不要 |
| `POS_AUTH_EMAIL` | 上記の運営用ユーザーのメールアドレス |
| `POS_COOKIE_SECRET` | ランダム32バイトを64桁の16進数にした文字列 |

Cookie用秘密鍵は `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` などで生成してください。共通パスワードとは別物です。値をGitにコミットせず、Vercelの環境変数に保存します。秘密鍵変更時は全端末で再ログインが必要です。

4. GitHubへpushしVercelを再デプロイ。環境変数を後から追加した場合も再デプロイが必要です。
5. アプリの履歴 → バックアップで「端末名」「共通パスワード」を入力。既存レジなら「この端末のバックアップを開始」を選びます。交換後の空の端末なら「交換前の端末から復元」を選びます。

認証はVercel APIからSupabase Authへ委譲し、同サービスの認証試行レート制限を利用します。パスワードは保存せず、セッションは暗号化したHttpOnly / Secure / SameSite=Strict Cookieで30日保持します。サーバーがアクセストークンを更新できない場合は再ログインを案内します。共通パスワードを知る人はバックアップ全件にアクセスできる運用です。端末名とパスワード入力時のみOSキーボードを使います。

通常会計・取消・価格変更後と、オンライン復帰時・表示中の約1分ごとに未送信分を再試行します。バックアップ画面に未送信件数（売上変更と価格変更）と最終送信時刻を表示します。通信成功後にのみ送信済みにし、応答を失った場合も同じIDで再送します。Web Locks対応の最新iPadOSブラウザを使用してください。

## SQLの実行

1. SupabaseプロジェクトのSQL Editorに `migrations/202610040001_backup.sql` の全文を貼り付けて実行します。初回導入用のため、一度だけ実行してください。既存テーブル名と衝突した場合はトランザクション全体が失敗し、既存データは削除しません。
2. 002の端末登録SQLも実行します。既存バックアップの端末には仮の端末名が付与されます。

## 保存内容とアクセス権

- `pos_backup_orders`: 全期間の売上と取消状態。金額は単価×数量をDBで生成します。
- `pos_backup_settings`: 現在単価と変更番号。価格は売上から独立してバックアップします。
- `pos_backup_devices`: 端末名、端末ID、登録日時。売上・価格から外部キーで参照します。
- ログインした本人の行だけ閲覧できます。未ログインでは読み書きできません。
- クライアントから直接INSERT/UPDATE/DELETEできません。書き込みは売上・価格・端末登録のRPCだけです。
- Supabase管理者権限は別です。ブラウザにservice_roleキーやDBパスワードを入れないでください。アプリ接続にはpublishableキー（旧anonキー）とログインセッションを使います。

## アプリ側のデータ

既存のIndexedDBの数値 `id` はそのまま保持し、各売上に `backupId`（UUID）、`sourceDeviceId`（UUID）、`sourceLocalId`（元の数値ID）を追加します。端末IDもIndexedDBに保存します。

既存売上の初回移行ではUUIDを一度だけ採番し、売上と一緒にローカルへ永続保存してから送信します。再送・アプリ更新・復元のたびに作り直してはいけません。DBは所有者＋元端末＋元IDの重複も拒否します。

端末交換後に復元した売上は、元のUUID・元端末ID・元IDを保持します。新しい売上は新端末IDで作成します。端末データを消した場合は端末IDを新規発行してください。

## 売上の送信契約

```js
await supabase.rpc('pos_backup_order', {
  p_order_id: order.backupId,
  p_source_device_id: order.sourceDeviceId,
  p_source_local_id: order.sourceLocalId,
  p_ordered_at_ms: order.date, // 現在のUnixミリ秒をそのまま使用
  p_unit_price: order.unitPrice,
  p_quantity: order.quantity,
  p_is_active: order.isActive,
});
```

同じ内容の再送では行が増えません。取消はfalseを送信します。取消が先に到着した場合も保存でき、その後古いtrueが届いてもfalseのままです。同じUUIDで数量や当時の単価を変更するとエラーになります。RPC返却行のis_activeがfalseなら復元やローカル状態へ反映します。

会計はローカルDBのコミットで完了させ、クラウドを待ちません。売上変更と送信待ち情報を同じIndexedDBトランザクションに保存します。送信中に取消された場合、古い送信の成功で新しい送信待ちを消さないよう、ローカルの変更番号を照合してください。

## 価格の送信契約

```js
await supabase.rpc('pos_backup_price', {
  p_current_unit_price: 350,
  p_expected_revision: 0, // 初回0。その後は直前の成功応答のrevision
  p_mutation_id: priceChangeId, // 変更ごとのUUID。再送時は同じ値
  p_source_device_id: deviceId,
});
```

価格の送信は順番に行い、応答のrevisionをIndexedDBに保存します。同じ要求の直後の再送は同じ結果を返します。新しい価格の後に古い要求が到着した場合は競合エラー40001で拒否します。競合時は最新バックアップを取得し、運用者がどちらの価格を採用するか判断して新しい要求を作ります。古い端末の値で自動上書きしないでください。

## iPad交換手順

1. 旧iPadの営業を止め、未送信が0件になったことを確認。念のためCSV/JSONも保存。
2. 新iPadで共通パスワードと新しい端末名を入力し、「交換前の端末から復元」で履歴・取消・価格・価格revisionを復元。新iPadで先に会計したりバックアップを開始しないでください。
3. 件数・合計を確認して新iPadで営業開始。旧iPadでの営業は再開しない。

復元は `pos_backup_orders` を `order_id` の安定した順序でページ分割して全件取得します（最初のレスポンスだけを全件とみなさない）。取消済みも対象です。取得・検証完了後、1つのローカルトランザクションで反映します。未送信のローカル売上がある端末には無条件で上書きしないでください。交換中は旧端末からの書き込みを停止します。

## 検証

`tests/backup.sql` は導入後の開発用Supabaseで実行する検証です。テストユーザーをトランザクション内に作り、最後にROLLBACKします。認証・再送・取消・価格競合を検証します。

ローカルの `tests/cloud-api.test.mjs` は認証上流をモックし、Cookieの改ざん拒否・CSRF対策・固定RPC・トークン更新を検証します。`tests/cloud-browser.cjs` はクラウド応答をモックし、旧データ移行・送信失敗・取消の競合・ページ分割復元・新端末IDを検証します。これらは本番Supabaseとの疎通確認の代わりにはなりません。設定後はテスト会計→クラウド確認→別の空のブラウザで復元まで実行してください。

参考: https://supabase.com/docs/guides/database/functions / https://supabase.com/docs/guides/database/postgres/row-level-security
