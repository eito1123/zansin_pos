# Supabase（クラウドバックアップ）の設定と運用

全端末の売上のバックアップ、全端末の集計、iPad 交換時の復元に使います。端末間のリアルタイム同期は行いません（各 iPad の価格・割引額は端末ごとの設定です）。

ログインは共通パスワードだけを入力する方式です。裏側では運営用の Supabase Auth ユーザー1名を全端末で共有し、端末はそれぞれの端末ID（UUID）と端末名で区別します。

## 初回設定（管理者）

1. **Supabase のプロジェクトを作る。** 無料プランで足ります。テスト環境を作る場合は、本番とは別のプロジェクトにする。
2. **SQL を実行する。** SQL Editor で、`migrations/` のファイルを**日付順にすべて**、1本ずつ全文を貼り付けて実行する。

   | ファイル | 内容 |
   |---|---|
   | `202610040001_backup.sql` | 売上・価格バックアップのテーブル、RLS、送信用 RPC |
   | `202610040002_devices.sql` | 端末登録（端末名・最終通信日時） |
   | `202610240001_coupons.sql` | クーポン（枚数・1枚あたりの割引額）と、金額の計算式の更新 |

   各ファイルはトランザクションになっていて、失敗した場合は何も変更されません。実行済みのファイルは再実行しないでください。

3. **運営用ユーザーを作る。** Authentication → Users でユーザーを1名作り、メール確認済みにして、十分に長いパスワードを設定する。このパスワードが、現場で入力する**共通パスワード**になる。新規登録（Sign up）は無効にしておく。
4. **Vercel に環境変数を登録する。** Project → Settings → Environment Variables に、次の4つを登録する。本番の値は **Production**、テスト用の値は **Preview** にだけ登録する（同じ変数に両方のチェックを入れない）。

   | 変数 | 値 |
   |---|---|
   | `SUPABASE_URL` | Project Settings → API の Project URL（`https://xxxx.supabase.co`。末尾に `/rest/v1/` は付けない） |
   | `SUPABASE_PUBLISHABLE_KEY` | Publishable key（旧 anon key）。**service_role キーは使わない** |
   | `POS_AUTH_EMAIL` | 手順3で作ったユーザーのメールアドレス |
   | `POS_COOKIE_SECRET` | ランダムな64文字の16進数（下のコマンドで生成）。共通パスワードとは別物 |

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   値は Git にコミットせず、Vercel にだけ保存します（形式は `.env.example` を参照）。`POS_COOKIE_SECRET` を変えると、全端末で再ログインが必要になります。

5. **再デプロイする。** 環境変数は、登録したあとのデプロイから反映されます。Vercel の Deployments から最新のデプロイを Redeploy してください。
6. **各 iPad でログインする。** アプリの売上履歴 → バックアップで、端末名と共通パスワードを入力する。通常のレジは「この端末のバックアップを開始」、交換後の空の端末は「交換前の端末から復元」を選ぶ。

### データベースを変更するとき
- 変更は `migrations/` に新しいファイルを追加し、本番では**アプリをデプロイする前に**実行する。先にデプロイすると、SQL を実行するまでバックアップ送信が失敗する（会計は端末内に残り、あとで再送される）。
- 本番で実行する前に、テスト用プロジェクトで実行して Preview で確認し、本番データのバックアップ（下の「データベース内にコピーを取る」）を取っておく。

## 認証とセッション

- アプリは Supabase に直接つながず、Vercel の API（`/api/cloud`）が中継します。API は `POS_AUTH_EMAIL` と入力されたパスワードで Supabase Auth にログインし、ログイン状態を暗号化して Cookie（HttpOnly / Secure / SameSite=Strict、30日）に保存します。パスワードは保存しません。
- API が受け付けるのは、決まった操作だけです：`login` / `logout` / `status` / `device`（端末登録）/ `order`（売上の送信）/ `devices`（端末一覧）/ `orders`（売上の取得）。
- **共通パスワードを知っている人は、全端末の売上を閲覧でき、バックアップに書き込めます。** 幹部（運営メンバー）だけに共有する前提です。データベース側で禁止しているのは、売上の行の削除と、過去の売上の金額・数量などの書き換えです。パスワードを知っていれば、偽の売上の追加と、正しい売上の取消（集計から外れる。行は「取消済み」として残る）はできます。
- **売上の端末ID・端末名は、端末側の自己申告です。** 全端末が同じアカウントでログインするため、サーバーは「どの端末から送られたか」を確かめられません（ほかの端末のIDを名乗って送ることもできます）。サーバーが付ける受信時刻（`backed_up_at` / `updated_at`）は信頼できます。端末を本当に区別するには、端末ごとの鍵の発行や操作の記録（監査ログ）が必要です。
- ログインしたブラウザ（iPad・PC）は、パスワードを入れなくても30日間はそのまま使えます。Supabase のプロジェクトを削除する、または `POS_COOKIE_SECRET` を変えると、すべてのログイン状態が無効になります。
- 同じブラウザでは、POS 画面と全端末の集計ページでログイン状態を共有します。集計ページでログアウトすると、そのブラウザのレジのバックアップも止まります。
- iPad のホーム画面アプリは、Safari とは別に Cookie やデータを持つことがあります。

## 保存内容とアクセス権

| テーブル | 内容 |
|---|---|
| `pos_backup_orders` | 全期間の売上と取消状態。単価・セット数・クーポン枚数・1枚あたりの割引額を保存し、金額（`amount`）はデータベースが「単価×セット数 − 割引額×クーポン枚数」で計算する |
| `pos_backup_devices` | 端末ID、端末名、登録日時、最終通信日時 |
| `pos_backup_settings` | 旧版で使っていた価格のバックアップ。**現在は使用しない**（価格は各端末のローカル設定） |

- ログインしたユーザー自身の行だけを読めます（RLS）。未ログインでは読み書きできません。
- クライアントは、テーブルを直接 INSERT / UPDATE / DELETE できません。書き込みは RPC の `pos_backup_order`（売上）と `pos_register_device`（端末登録）だけです（`pos_backup_price` は旧版用で、今のアプリは使いません）。
- 管理者が SQL Editor や Table Editor で操作する場合は、この制限を受けません。

## バックアップの送信

- 送信のタイミング：会計・取消の直後、オンラインに戻ったとき、アプリを開いたとき、画面を表示している間は約1分ごと。
- 通信が成功したときだけ送信済みにします。応答が返ってこなかった場合も、同じIDで再送します（行は増えません）。
- 取消は `is_active = false` として送ります。取消が先に届いても、あとから古い「有効」が届いても、取消のまま維持されます。
- 同じIDで、単価・セット数・クーポン枚数・割引額などを変えた内容が届くと、エラーになります（売上の改ざん防止）。
- 同じ端末でアプリを複数のタブで開いても二重に送信しないよう、ブラウザの Web Locks を使います。最新の iPadOS の Safari を使ってください。

### 送信の仕様（`api/cloud.js` が呼ぶ RPC）

```js
rpc('pos_backup_order', {
  p_order_id: order.backupId,             // UUID。端末で一度だけ採番し、再送でも同じ値
  p_source_device_id: order.sourceDeviceId,
  p_source_local_id: order.sourceLocalId, // 端末内の連番ID
  p_ordered_at_ms: order.date,            // 会計時刻（Unix ミリ秒）
  p_unit_price: order.unitPrice,          // 会計時点の単価
  p_quantity: order.quantity,
  p_coupon_count: order.couponCount,      // 適用したクーポン枚数（セット数以下）
  p_coupon_discount: order.couponDiscount,// 1枚あたりの割引額（クーポンなしなら 0）
  p_is_active: order.isActive,
});
```

クーポン対応前の7引数版（`p_coupon_count` と `p_coupon_discount` がないもの）も、旧版のアプリのために残しています（クーポンは0枚として保存）。

## アプリ側のデータ（IndexedDB）

- 売上（`orders`）：端末内の連番 `id` に加えて、`backupId`（UUID）、`sourceDeviceId`、`sourceLocalId`、送信管理用の `version` / `syncedVersion` を持ちます。UUID は一度だけ採番して保存し、再送・更新・復元で作り直しません。
- 設定（`settings`）：価格（`currentUnitPrice`）、割引額（`couponDiscount`）、クラウドの状態（端末ID・端末名・ログイン先・最終送信時刻）。
- 端末は、最初にバックアップしたアカウント（ユーザーID）を記録します。別のアカウントでログインすると「保存済みデータとログイン先が異なります」と表示し、データが混ざらないよう送信を止めます。

## 全端末の集計ページ

- `/dashboard.html`（POS の売上履歴 →「全端末の集計」）。共通パスワードでログインし、PC やスマートフォンからも開けます。閲覧専用です。
- 表示：日付ごと（今日・各日・全期間）の売上合計・セット数・会計件数、端末別（最終通信が10分以上前なら「通信なし」）、単価別、時間帯別（売上金額・セット数・会計回数・クーポン数を切り替え）。約1分ごとに自動更新します。
- 「○○を印刷 / PDF」：選んでいる期間の全端末の売上明細（取消済みを含む）と、表の下に合計（セット数・クーポン・金額）を印刷・PDF保存します。

## iPad 交換手順

1. 旧 iPad の営業を止め、未送信が0件になったことを確認する。
2. 新 iPad で、共通パスワードと新しい端末名を入力してログインし、「交換前の端末から復元」→ 交換前の端末を選んで復元する。
   - 選んだ端末の売上（取消済みを含む）だけを取り込み、ほかのレジの売上は取り込まない。
   - 交換を繰り返した場合（A→B→C）は、A と B の両方を選ぶ。
   - 価格と割引額は復元されないので、設定画面で設定する。
   - 復元より先に、新 iPad で会計したりバックアップを開始したりしない（復元は売上が空の端末でしかできない）。
3. 件数と合計を確認してから、新 iPad で営業を始める。旧 iPad では営業を再開しない。

## 会期後のデータ書き出し

SQL Editor で実行します。結果の表示が100行までに制限されることがあるため、**結果を1セルにまとめて**出力します。

### CSV
結果のセルの中身をコピーし、メモ帳に貼り付けて「UTF-8 (BOM 付き)」で `sales.csv` として保存すると、Excel でそのまま開けます。結果の「Export → CSV」は使わないでください（CSV がもう1段 CSV で包まれ、Excel で1列に入ってしまいます）。

```sql
select '日時,端末,単価,数量,クーポン枚数,クーポン1枚の割引額,金額,状態,order_id' || E'\n' ||
  string_agg(
    concat_ws(',',
      to_char(to_timestamp(o.ordered_at_ms / 1000.0) at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS'),
      '"' || replace(coalesce(d.name, ''), '"', '""') || '"',
      o.unit_price, o.quantity, o.coupon_count, o.coupon_discount, o.amount,
      case when o.is_active then '完了' else '取消済み' end,
      o.order_id
    ),
    E'\n' order by o.ordered_at_ms
  ) as csv
from public.pos_backup_orders o
left join public.pos_backup_devices d
  on d.owner_id = o.owner_id and d.device_id = o.source_device_id;
```

### JSON

```sql
select jsonb_pretty(jsonb_agg(to_jsonb(t) order by t.ordered_at_ms)) as json
from (
  select o.order_id,
    to_char(to_timestamp(o.ordered_at_ms / 1000.0) at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS+09:00') as ordered_at,
    o.ordered_at_ms, d.name as device_name, o.unit_price, o.quantity,
    o.coupon_count, o.coupon_discount, o.amount, o.is_active
  from public.pos_backup_orders o
  left join public.pos_backup_devices d
    on d.owner_id = o.owner_id and d.device_id = o.source_device_id
) t;
```

### 件数の確認

```sql
select count(*) as 全件数,
       count(*) filter (where is_active) as 有効件数,
       sum(quantity) filter (where is_active) as セット数,
       sum(amount) filter (where is_active) as 売上合計
from public.pos_backup_orders;
```

書き出したファイルの行数（CSV は見出しを除く）が「全件数」と、売上の合計が全端末の集計ページの全期間の数字と一致することを確認してください。

### データベース内にコピーを取る
本番で SQL を実行する前などに使います。外部の API から見えない専用のスキーマにコピーします（日付の部分は実行日に変える）。

```sql
begin;
create schema if not exists pos_snapshot;
revoke all on schema pos_snapshot from public, anon, authenticated;
create table pos_snapshot.orders_20261024 as table public.pos_backup_orders;
create table pos_snapshot.devices_20261024 as table public.pos_backup_devices;
commit;
```

## 検証

- `tests/backup.sql`：導入後の**開発用** Supabase の SQL Editor で実行する検証です。テストユーザーをトランザクション内で作り、最後に ROLLBACK します。認証・再送・取消を確認します（クーポン用の SQL より前に作ったもので、7引数版の RPC と旧版の価格 RPC を使います）。
- `tests/cloud-api.test.mjs`（`npm test`）：Supabase をモックして、Cookie の改ざん拒否、CSRF 対策、許可した操作だけを受け付けること、トークンの更新、送信する値を確認します。
- `tests/cloud-browser.cjs`：クラウドの応答をモックして、旧データの移行、送信失敗と再送、取消の競合、復元（端末の選択・ページ分割）を確認します。
- これらは本物の Supabase との接続確認の代わりにはなりません。設定後は、テスト会計 → 全端末の集計で表示を確認 → 別の空のブラウザで復元、まで実際に試してください。

参考：https://supabase.com/docs/guides/database/functions / https://supabase.com/docs/guides/database/postgres/row-level-security
