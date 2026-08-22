# 仕様書 — claude-projects

最終更新: 2026-08-22

## 1. 概要

React製のWebアプリ。ダッシュボード画面と、netkeiba.comから競馬データをスクレイピングして
血統・過去実績をもとに予想スコアと推奨買い目を算出する「競馬予想」機能を持つ。

## 2. 構成

```
claude-projects/
├── src/                      # フロントエンド (React + TypeScript, Vite)
│   ├── App.tsx                # ルーティング定義 (react-router-dom)
│   ├── components/
│   │   ├── AppNavbar.tsx      # ナビゲーションバー
│   │   ├── Dashboard.tsx      # ダッシュボード画面 (ダミー統計データ)
│   │   └── Prediction.tsx     # 競馬予想画面
│   └── main.tsx                # エントリポイント (Bootstrap CSS/JS読み込み)
├── server/                   # バックエンド (Express + TypeScript, tsx実行)
│   ├── index.ts                # APIサーバー本体
│   ├── netkeiba.ts             # netkeibaスクレイピング処理
│   └── predict.ts              # 予想スコアリング・買い目生成ロジック
├── vite.config.ts             # /api を localhost:3001 へプロキシ
└── package.json
```

### 技術スタック

| 分類 | 技術 |
|---|---|
| フロントエンド | React 18, TypeScript, Vite 5, react-router-dom, Bootstrap 5, Bootstrap Icons |
| バックエンド | Express 5, TypeScript (tsx実行), axios, cheerio, iconv-lite |
| 実行環境 | Node.js 24 (LTS) |

## 3. 画面

### 3.1 ダッシュボード (`/`)

固定のダミー統計データ（総ユーザー数・売上・注文数・コンバージョン率）と最近のアクティビティ一覧を
Bootstrapのカード/グリッドで表示する画面。実データとは連携していない。

### 3.2 競馬予想 (`/predict`)

1. netkeibaのrace_id（12桁）またはレースURLを入力
2. `GET /api/predict/:raceId` を呼び出し、出走馬ごとの過去成績・血統を取得してスコアリング
3. 結果を以下の形式で表示
   - **推奨買い目カード**: 信頼度（堅い/やや堅い/混戦）と単勝〜三連単の推奨買い目
   - **予想結果テーブル**: 予想順位・馬番・馬名・性齢・騎手・脚質・父・人気・スコア
   - 各行の「詳細」ボタンでスコア内訳（進捗バー）と3世代血統（曾祖父母まで）を展開表示

## 4. API仕様

### `GET /api/predict/:raceId`

| 項目 | 内容 |
|---|---|
| パスパラメータ | `raceId` — netkeibaのrace_id（8〜12桁の数字。形式不一致は400） |
| 処理 | 出馬表を取得後、出走馬ごとに過去成績・血統を**直列で400ms間隔**を空けて取得（netkeibaへの負荷軽減のため） |
| 成功時 (200) | `{ race, predictions, bets }` |
| 出走馬0件 (404) | `{ error }` |
| 取得失敗 (502) | `{ error }` |

#### レスポンス型

```
race: {
  raceId, raceName, course, distance,
  surface: 'turf' | 'dirt' | 'unknown',
  trackCondition,           // 例: "良" "稍重" "重" "不良"
  horses: RaceCardHorse[]
}

predictions: HorsePrediction[]   // スコア降順、rank付与済み
  = { horse, pedigree, runningStyle, score, breakdown, rank }

bets: BetSuggestions | null       // 出走3頭未満の場合はnull
```

## 5. データ取得元 (netkeiba.ts)

| 関数 | 取得元URL | 内容 |
|---|---|---|
| `fetchRaceCard` | `race.netkeiba.com/race/shutuba.html?race_id=` | 出走馬一覧・枠番・馬番・斤量・騎手・厩舎・馬体重・オッズ・人気 |
| `fetchHorseHistory` | `db.netkeiba.com/horse/result/{horseId}/` | 過去全レースの日付・開催・距離・馬場状態・着順・人気・騎手・タイム・通過順位・上がり3F |
| `fetchPedigree` | `db.netkeiba.com/horse/ped/{horseId}/` | 5代血統表HTMLを`rowspan`展開して3世代（父母・祖父母4頭・曾祖父母8頭、計14頭）を復元 |

ページはEUC-JPで配信されるため、バイナリ取得後にUTF-8判定→フォールバックでEUC-JPデコードする。

**注意:** netkeiba.comの利用規約はスクレイピングを制限している場合があるため、個人利用・低頻度アクセス
を前提とする。HTML構造の変更により、CSSセレクタや列インデックスの調整が必要になることがある。

## 6. 予想スコアリング (predict.ts)

出走馬ごとに0〜100点の要素スコアを算出し、重み付き合計で最終スコアを出す。

| 要素 | 重み | 算出方法 |
|---|---|---|
| 近走成績 (recentForm) | 20% | 直近5走の着順を、新しいレースほど重く加重平均（1着=100点〜） |
| 距離適性 (distanceAptitude) | 13% | 今回距離±400m以内のレースでの平均着順スコア |
| 馬場適性 (surfaceAptitude) | 8% | 芝/ダートが一致するレースでの平均着順スコア |
| 馬場状態適性 (trackConditionAptitude) | 7% | 良/稍重/重/不良が一致するレースでの平均着順スコア |
| クラス適性 (classAdequacy) | 12% | レース名から級別（新馬〜G1）を判定し、今回のクラスで通用する実績があるか評価 |
| 騎手相性 (jockeyContinuity) | 5% | 同騎手での過去成績＋乗り替わりなしのボーナス(+5) |
| コンディション (condition) | 8% | 前走からの馬体重増減（絶対値が大きいほど減点） |
| 血統 (pedigree) | 17% | 3世代の血統を世代が近いほど重く加重平均（母父を特に重視） |
| 市場評価 (market) | 10% | 現在の人気順位（未確定時は中立点50） |

血統評価は`SIRE_RATING`という手動キュレーションの著名種牡馬リスト（約20頭）による簡易評価であり、
本格的な血統統計データベースの代替ではない。リスト外の馬は中立点(50)。

## 7. 買い目推奨ロジック (suggestBets)

1. 予想1位と2位のスコア差（`scoreGap`）から信頼度を判定
   - 8点以上 → 「堅い」→ BOX 3頭
   - 4〜8点未満 → 「やや堅い」→ BOX 4頭
   - 4点未満 → 「混戦」→ BOX 5頭
2. 上位BOX頭数から各券種を生成
   - 単勝・複勝: 上位馬をそのまま推奨
   - 馬連・ワイド: BOX全頭の組み合わせ
   - 馬単・三連単: 1位を軸に固定し、2着（・3着）へBOX内の他馬を流す
   - 三連複: BOX全頭の組み合わせ

出走3頭未満の場合は`bets: null`を返す。

## 8. 開発・実行方法

```bash
npm install
npm run dev:all     # フロントエンド(5173) + APIサーバー(3001) を同時起動
```

個別起動: `npm run dev`（フロントのみ）/ `npm run server`（APIのみ、ファイル変更で自動再起動）

ビルド: `npm run build`（`tsc -b && vite build`。server/配下は含まれない。型チェックは
`npx tsc -p tsconfig.server.json --noEmit` で個別に実施）

## 9. 既知の制約・未実装事項

- 予想結果の保存機能なし（過去の予想を振り返ることができない）
- 実際のレース結果（着順・払戻金）を取得する機能なし
- 上記2点により、**的中率の集計は未対応**
- 血統評価は簡易リストベースで、統計的裏付けのある血統データベースではない
- オッズ・人気はレース発走が近づくまで取得できないことが多い（`null`で返る）
- netkeibaのHTML構造変更に弱い（セレクタ・列インデックスのハードコード依存）

## 10. 今後の拡張候補

- 予想結果の自動保存（DB導入）
- レース確定後の結果自動取得・照合による的中率集計（券種別）
- 血統評価の統計データベース化
