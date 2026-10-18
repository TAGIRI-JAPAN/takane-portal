# takane-portal

髙根 未来のポータルサイト。資料PDF・サイトリンク・写真・プロフィールをまとめた公開ページと、パスワード付きの管理ページ。

- 公開ページ: `index.html` → https://tagiri-japan.github.io/takane-portal/
- 管理ページ: `admin.html` → https://tagiri-japan.github.io/takane-portal/admin.html

## 仕組み

- サーバーなし。管理ページはブラウザから GitHub Contents API を呼び、このリポジトリに直接コミットする
- `data/site.json` が全データ。`uploads/` にファイル本体
- `data/vault.json` は GitHub トークンをパスワードで暗号化したもの（PBKDF2 + AES-GCM）。初回設定で管理ページが自動生成する
- main に push されると GitHub Actions が Pages に公開（反映まで 1〜2 分）
- `robots.txt` と `noindex` で検索エンジンには載せない

## 初回設定

1. GitHub で Fine-grained token を発行
   - Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
   - Resource owner: TAGIRI-JAPAN　Repository access: Only select repositories → takane-portal
   - Permissions → Repository permissions → Contents: **Read and write**
   - Expiration は長め（1年など）に
2. 管理ページを開き、トークンと新しいパスワードを入力して「設定して開始」
3. 以後はパスワードだけでログイン。トークンの期限が切れたら「設定」タブで入れ替え
