# Safari版の導入方法

macOSのSafari向け拡張機能です。現在のバージョンは **1.5.1** です。機能の説明は [ルートのREADME](../README.md) を参照してください。

## 一時拡張として読み込む

Safari 18.4以降のmacOSでは、Xcodeプロジェクトをビルドせず、拡張機能のソースフォルダを一時的に読み込めます。[WebKit公式の説明](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/#temporary-extension-installation)

1. リポジトリをダウンロードして展開します。
2. Safariの「設定」→「詳細」で「Webデベロッパ用の機能を表示」を有効にします。
3. 「デベロッパ」の機能拡張設定で、一時拡張を追加する項目を開きます。
4. このリポジトリの `safari/` フォルダを選びます。Safari用の `manifest.json` を含むフォルダです。
5. Safariの「設定」→「機能拡張」でSarashinaを有効にし、利用するWebサイトへのアクセスを許可します。
6. ツールバーのSarashinaアイコンから設定を開き、APIキーを入力します。
7. 「接続テスト」でAPIサイトへのアクセスを許可し、「設定を保存」を押します。

一時拡張は永続的なインストールではありません。Safari終了後などに使えなくなった場合は再追加してください。アプリ版も入っている場合は、一時拡張とアプリ版の両方を同時に有効にしないでください。

## Xcodeアプリ版を使う

付属のプロジェクトは、Safariの拡張機能設定を開くmacOSアプリと、Safari Web Extensionを含みます。`safari/` のソースを直接参照する構成です。ソースを更新した場合は再ビルドしてください。

現在の親プロジェクトのmacOS Deployment Targetは **27.0**、拡張機能ターゲットは **12.0** です。親プロジェクトの設定が適用されるため、アプリ版をより古いmacOSで使える構成にはしていません。一時拡張としての読み込みとは別の条件です。

1. Xcodeで `Safari_App/SarashinaTranslator/SarashinaTranslator.xcodeproj` を開きます。
2. Schemeを「SarashinaTranslator」、実行先を「My Mac」にします。
3. 署名が必要な場合は、Signing & Capabilitiesで自分の環境の署名設定を選びます。
4. Safariの開発設定で「未署名の機能拡張を許可」が必要な場合は有効にします。
5. Xcodeで `Command + R` を押し、ビルド・実行します。
6. アプリの「Quit and Open Safari Settings…」からSafariの設定を開きます。
7. 「SarashinaTranslator Extension」を有効にし、対象サイトへのアクセスを許可します。
8. 拡張機能の設定でAPIキーを入力し、接続テスト後に「設定を保存」を押します。

`Command + R` はビルドと実行までです。Safari側の有効化とアクセス許可は別途必要です。[Apple公式の実行ガイド](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)

ターミナルでプロジェクトを開く場合は、リポジトリのルートで次を実行します。

```bash
open Safari_App/SarashinaTranslator/SarashinaTranslator.xcodeproj
```

## 使い方

| 操作 | 方法 |
|---|---|
| 選択翻訳 | 文章を選び、右クリックの「Sarashinaで選択部分を翻訳」 |
| ショートカット | 文章を選び、`Option + Shift + Y` |
| 原文の解説 | 右クリックの「Sarashinaで選択部分を解説」、または翻訳カードの「解説」 |
| 訳文のニュアンス | 翻訳後、翻訳結果の横にある「訳文のニュアンス」 |
| 選択部分の置き換え | 翻訳カードの「原文を訳文に置き換える」。本文・対応する入力欄で利用可能 |
| ページ全体翻訳 | 右クリックメニュー、またはツールバーのポップアップ |
| 手動翻訳 | ツールバーのポップアップへ文章を入力 |

## 接続できないとき

- 接続テスト後に「設定を保存」を押したか確認します。接続テストだけでは保存されません。
- Safariで翻訳対象サイトだけでなく、設定したAPIサイトへのアクセスも許可されているか確認します。
- `Load failed` の場合は、ネットワーク、APIベースURL、APIサイトへの許可を確認します。
- ブラウザーの内部ページなど、拡張機能を実行できない場所では通常のWebページで試してください。
- 自動判定で翻訳方向が合わない場合は、「英語 → 日本語」または「日本語 → 英語」を明示します。

## ソースを更新したとき

一時拡張は再読み込みまたは再追加し、対象ページも再読み込みします。Xcodeアプリ版は再ビルド・実行後に対象ページを再読み込みしてください。
