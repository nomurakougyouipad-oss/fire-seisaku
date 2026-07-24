# セットアップ手順 — 消防車両 製作管理アプリ（fire-seisaku）

このアプリは **静的サイト（HTML/CSS/JS のみ・ビルド不要）** です。
データは **Firebase Firestore**、写真は **Firebase Storage** に保存し、全端末でリアルタイム同期します。

> **現在の実装範囲：段階1（案件一覧・案件詳細・データ登録・進捗管理）**
> 段階2以降（写真アップロード／工程ボード・部品・検査／図面ビューア）は順次追加します。
> 構成は拡張しやすいように分割済みです（`js/` 参照）。

---

## 1. まず最初に：Firebase の「匿名認証」を有効化する（必須）

このアプリはログイン画面を持たず、**匿名認証**で Firebase に接続します。
これを有効にしないと、データの読み書きが一切できません（画面に接続エラーが出ます）。

1. [Firebase コンソール](https://console.firebase.google.com/) を開き、プロジェクト **fire-seisaku** を選択
2. 左メニュー **構築 → Authentication** を開く
3. **始める（Get started）** をクリック
4. **Sign-in method** タブ →「ネイティブのプロバイダ」から **匿名（Anonymous）** を選び、**有効にする → 保存**

これで匿名サインインが使えるようになります。

---

## 2. セキュリティルールを適用する（テストモードから差し替え）

FirestoreとStorageは現在「テストモード」で、**30日で失効すると全アクセスが遮断されます**。
同梱のルールに差し替えてください（匿名認証済みのみ許可＋入力値の検証）。

### Firestore ルール
1. Firebase コンソール **構築 → Firestore Database → ルール** タブ
2. 内容をすべて削除し、同梱の **`firestore.rules`** の中身を貼り付け
3. **公開（Publish）**

### Storage ルール
1. Firebase コンソール **構築 → Storage → ルール** タブ
2. 内容をすべて削除し、同梱の **`storage.rules`** の中身を貼り付け
3. **公開（Publish）**

> Storage をまだ使い始めていない場合は、Storage 画面で **始める** を押して有効化してください（写真は段階2から使用）。

### このセキュリティ設計について（正直な注意）
- 匿名認証＋ルールにより、**未認証のアクセスや不正な形式のデータ書き込みは防げます**。
- ただし匿名トークンは誰でも取得できるため、これ**だけ**では「悪意ある第三者による書き込み」を完全には防げません。
- 社内・関係者限定の運用であればこの構成で十分実用的です。より堅くするなら、本番稼働後に
  **Firebase App Check（reCAPTCHA / App Attest）** の導入を推奨します（アプリのコード変更は最小限で済みます）。

---

## 3. ローカルで動作確認する

このアプリは ES モジュールを使うため、**`index.html` をファイルとして直接ダブルクリックでは動きません**（ブラウザの制約）。
簡易サーバー経由で開いてください。フォルダ内で以下のいずれかを実行します。

```bash
# Node.js がある場合
npx serve .
```

```bash
# Python がある場合
python -m http.server 5173
```

表示された URL（例：`http://localhost:5173`）をブラウザで開きます。
初回アクセス時にサンプル案件7件が自動登録されます。

---

## 4. GitHub Pages で公開する

1. GitHub で **`fire-seisaku`** という名前のリポジトリを作成（Public 推奨）
2. このフォルダの中身を一式プッシュ

```bash
cd fire-seisaku
git init
git add .
git commit -m "消防車両 製作管理アプリ 段階1"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/fire-seisaku.git
git push -u origin main
```

3. GitHub のリポジトリ **Settings → Pages**
   - **Source**：`Deploy from a branch`
   - **Branch**：`main` / `/(root)` を選び **Save**
4. 数分後、`https://<ユーザー名>.github.io/fire-seisaku/` で公開されます

> `.nojekyll` を同梱済みなので、`js/` フォルダも正しく配信されます。

### Firebase 側で公開URLを許可する
1. Firebase コンソール **Authentication → Settings → 承認済みドメイン**
2. **ドメインを追加** で `<ユーザー名>.github.io` を追加

---

## 5. スマホでアプリのように使う（PWA・ホーム画面に追加）

公開URLをスマホのブラウザで開き、以下で「ホーム画面に追加」できます。
アイコン・スプラッシュ付きで、全画面アプリのように起動します。

- **iPhone（Safari）**：共有ボタン → 「ホーム画面に追加」
- **Android（Chrome）**：メニュー(⋮) → 「アプリをインストール」／「ホーム画面に追加」

---

## 6. 段階1の使い方・確認ポイント

- **案件一覧**（トップ）：KPI・検索・工程ステッパー・進捗・原価・納期・状態を一覧表示（PCは表／スマホはカード）
- **＋新規案件**：管理No・車両タイプ等を入力して登録（管理No が案件ID になります）
- **行／カードをタップ**：案件詳細へ。7工程を縦に並べたフォトログ画面
- **編集 / 削除**：案件詳細から実行
- **次の工程へ進める →**：現在工程を1つ進め、進捗%も自動更新
- すべての変更は Firestore に保存され、**別の端末を開くと即座に反映**されます（リアルタイム同期）

> 案件詳細の「＋写真を追加」は**段階2**で有効になります（現在は案内が表示されます）。

---

## ファイル構成

```
fire-seisaku/
├── index.html              アプリ本体（SPA）
├── app.css                 デザインシステム（Industry + 消防レッド）
├── firebase-config.js      Firebase 接続設定（同梱・実プロジェクト）
├── manifest.webmanifest    PWA マニフェスト
├── sw.js                   Service Worker（オフラインシェル）
├── firestore.rules         Firestore セキュリティルール ← 適用してください
├── storage.rules           Storage セキュリティルール ← 適用してください
├── .nojekyll               GitHub Pages 用
├── js/
│   ├── app.js              画面描画・ルーティング・操作
│   ├── firebase.js         Firebase 初期化・匿名認証
│   ├── store.js            Firestore データ層（案件・写真・シード）
│   ├── util.js             工程定義・金額/日付・進捗計算
│   └── image.js            画像リサイズ（長辺1600px・約300KB／段階2で使用）
├── icons/                  アプリアイコン一式
└── images/                 デザイン参照（プロトタイプ書き出し）
```
