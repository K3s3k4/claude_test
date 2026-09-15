// JRDBアーカイブ全体を使って、複数指数(IDM・騎手指数・情報指数・調教指数・厩舎指数)+市場オッズ+
// 枠番+競馬場+血統(父馬・母父馬の勝率エンコーディング)を特徴量としたロジスティック回帰モデルを学習し、
// 現行(総合指数のみ)を上回るか検証する。
// 時系列でtrain/testを分割し、testデータ(モデルが見ていない期間)での実際の馬券回収率で評価する。
// 血統の勝率エンコーディングはtrainデータのみから計算し、testには一切使わない(リーク防止)。
// 実行: npx tsx scripts/jrdb-train-model.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { empiricalBayesShrink } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseUkcBuffer, VENUE_NAMES, type KyiRow, type SedRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
async function listAvailableDates(): Promise<Date[]> {
  const dir = path.join(DATA_DIR, 'Kyi')
  const files = await fs.readdir(dir)
  const dates: Date[] = []
  for (const f of files) {
    const m = f.match(/^KYI(\d{2})(\d{2})(\d{2})\.txt$/)
    if (!m) continue
    dates.push(new Date(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  }
  return dates.sort((a, b) => a.getTime() - b.getTime())
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const VENUE_CODES = Object.keys(VENUE_NAMES)

// 血統(父馬・母父馬)の勝率エンコーディングを含まないベース特徴量
const BASE_FEATURE_NAMES = [
  'idm',
  'jockeyIndex',
  'infoIndex',
  'trainingIndex',
  'stableIndex',
  'overallIndex',
  'marketLogProb',
  'basePopularity',
  'headCount',
  ...Array.from({ length: 8 }, (_, i) => `waku${i + 1}`),
  ...VENUE_CODES.map((c) => `venue${c}`),
]
const FEATURE_NAMES = [...BASE_FEATURE_NAMES, 'sireWinRate', 'damSireWinRate']

type RawSample = {
  raceKey: string
  umaban: number
  baseFeatures: number[]
  sireName: string
  damSireName: string
  win: boolean
  tanshoPayout: number
}

async function buildDataset(): Promise<RawSample[]> {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  const samples: RawSample[] = []

  for (const date of pastDates) {
    const dateStr8 = toYymmdd(date)
    let kyiBuf: Buffer
    let sedBuf: Buffer
    try {
      kyiBuf = await fs.readFile(path.join(DATA_DIR, 'Kyi', `KYI${dateStr8}.txt`))
      sedBuf = await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${dateStr8}.txt`))
    } catch {
      continue
    }
    const kyiRows = parseKyiBuffer(kyiBuf)
    const sedRows = parseSedBuffer(sedBuf)

    let ukcByKetto: Map<string, UkcRow> | null = null
    try {
      const ukcBuf = await fs.readFile(path.join(DATA_DIR, 'Ukc', `UKC${dateStr8}.txt`))
      const ukcRows = parseUkcBuffer(ukcBuf)
      ukcByKetto = new Map(ukcRows.map((r) => [str(r.kettoNumber), r]))
    } catch {
      // UKC未取得の日は血統情報なしで進める(sireName/damSireNameは空のまま)
    }

    const grouped = new Map<string, KyiRow[]>()
    for (const r of kyiRows) {
      const key = `${r.venueCode}-${r.raceNumber}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(r)
    }

    for (const [key, horses] of grouped) {
      if (horses.length < 3) continue
      const venueCode = String(horses[0].venueCode)
      const raceNumber = Number(horses[0].raceNumber)
      const headCount = horses.length

      for (const h of horses) {
        const umaban = num(h.umaban)
        const sed = sedRows.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === umaban)
        if (!sed) continue

        const odds = num(h.baseOdds)
        const marketLogProb = odds > 0 ? Math.log(1 / odds) : 0
        const waku = num(h.waku)
        const wakuOneHot = Array.from({ length: 8 }, (_, i) => (waku === i + 1 ? 1 : 0))
        const venueOneHot = VENUE_CODES.map((c) => (venueCode === c ? 1 : 0))

        const ukc = ukcByKetto?.get(str(h.kettoNumber))
        const sireName = ukc ? str(ukc.sireName) : ''
        const damSireName = ukc ? str(ukc.damSireName) : ''

        const baseFeatures = [
          num(h.idm),
          num(h.jockeyIndex),
          num(h.infoIndex),
          num(h.trainingIndex),
          num(h.stableIndex),
          num(h.overallIndex),
          marketLogProb,
          num(h.basePopularity),
          headCount,
          ...wakuOneHot,
          ...venueOneHot,
        ]

        samples.push({
          raceKey: `${dateStr8}-${key}`,
          umaban,
          baseFeatures,
          sireName,
          damSireName,
          win: num(sed.tanshoPayout) > 0,
          tanshoPayout: num(sed.tanshoPayout),
        })
      }
    }
  }
  return samples
}

// 父馬(または母父馬)ごとの勝率を経験ベイズ補正つきで算出する(少頭数の父馬は全体平均に寄せる)。
function buildPedigreeWinRates(samples: RawSample[], key: 'sireName' | 'damSireName'): { table: Map<string, number>; globalMean: number } {
  const globalMean = samples.filter((s) => s.win).length / samples.length
  const stats = new Map<string, { wins: number; count: number }>()
  for (const s of samples) {
    const name = s[key]
    if (!name) continue
    const cur = stats.get(name) ?? { wins: 0, count: 0 }
    cur.count += 1
    if (s.win) cur.wins += 1
    stats.set(name, cur)
  }
  const table = new Map<string, number>()
  for (const [name, { wins, count }] of stats) {
    table.set(name, empiricalBayesShrink((wins / count) * 100, count, globalMean * 100, 20) / 100)
  }
  return { table, globalMean }
}

// --- 標準化 ---
function computeStandardizer(X: number[][]) {
  const n = X.length
  const dim = X[0].length
  const mean = new Array(dim).fill(0)
  for (const row of X) for (let i = 0; i < dim; i++) mean[i] += row[i] / n
  const std = new Array(dim).fill(0)
  for (const row of X) for (let i = 0; i < dim; i++) std[i] += (row[i] - mean[i]) ** 2 / n
  for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i]) || 1
  return { mean, std }
}
function standardize(features: number[], mean: number[], std: number[]): number[] {
  return features.map((v, i) => (v - mean[i]) / std[i])
}

// --- ロジスティック回帰(バッチ勾配降下法 + L2正則化) ---
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z))
}
function trainLogisticRegression(X: number[][], y: number[], epochs: number, lr: number, l2: number): { weights: number[]; bias: number } {
  const dim = X[0].length
  const n = X.length
  const weights = new Array(dim).fill(0)
  let bias = 0

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(dim).fill(0)
    let gradB = 0
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, v, j) => s + v * weights[j], bias)
      const pred = sigmoid(z)
      const err = pred - y[i]
      for (let j = 0; j < dim; j++) gradW[j] += (err * X[i][j]) / n
      gradB += err / n
    }
    for (let j = 0; j < dim; j++) weights[j] -= lr * (gradW[j] + l2 * weights[j])
    bias -= lr * gradB
  }
  return { weights, bias }
}
function predict(features: number[], weights: number[], bias: number): number {
  const z = features.reduce((s, v, j) => s + v * weights[j], bias)
  return sigmoid(z)
}

async function main() {
  console.log('データセットを構築中...')
  const rawSamples = await buildDataset()
  const withPedigree = rawSamples.filter((s) => s.sireName).length
  console.log(
    `サンプル数: ${rawSamples.length}(${new Set(rawSamples.map((s) => s.raceKey)).size}レース、うち血統判明${withPedigree}件)\n`,
  )

  // 時系列でtrain(古い80%) / test(新しい20%)に分割
  const raceKeys = [...new Set(rawSamples.map((s) => s.raceKey))].sort()
  const splitIdx = Math.floor(raceKeys.length * 0.8)
  const trainRaceKeys = new Set(raceKeys.slice(0, splitIdx))
  const trainRaw = rawSamples.filter((s) => trainRaceKeys.has(s.raceKey))
  const testRaw = rawSamples.filter((s) => !trainRaceKeys.has(s.raceKey))
  console.log(`train: ${trainRaw.length}件 / test: ${testRaw.length}件\n`)

  // 血統の勝率エンコーディングはtrainのみから計算(リーク防止)
  const sireStats = buildPedigreeWinRates(trainRaw, 'sireName')
  const damSireStats = buildPedigreeWinRates(trainRaw, 'damSireName')
  function withPedigreeFeatures(s: RawSample): number[] {
    const sireRate = s.sireName ? (sireStats.table.get(s.sireName) ?? sireStats.globalMean) : sireStats.globalMean
    const damSireRate = s.damSireName ? (damSireStats.table.get(s.damSireName) ?? damSireStats.globalMean) : damSireStats.globalMean
    return [...s.baseFeatures, sireRate, damSireRate]
  }

  const trainX = trainRaw.map(withPedigreeFeatures)
  const trainY = trainRaw.map((s) => (s.win ? 1 : 0))
  const { mean, std } = computeStandardizer(trainX)
  const X = trainX.map((f) => standardize(f, mean, std))

  console.log('学習中...')
  const { weights, bias } = trainLogisticRegression(X, trainY, 300, 0.3, 0.001)
  console.log('学習完了\n')

  const importances = FEATURE_NAMES.map((name, i) => ({ name, weight: weights[i] })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
  console.log('特徴量の重み(影響度上位12):')
  for (const imp of importances.slice(0, 12)) {
    console.log(`  ${imp.name}: ${imp.weight.toFixed(3)}`)
  }

  // --- testセットで評価 ---
  type EvalSample = { raceKey: string; features: number[]; overallIndex: number; win: boolean; tanshoPayout: number }
  const testSamples: EvalSample[] = testRaw.map((s) => ({
    raceKey: s.raceKey,
    features: withPedigreeFeatures(s),
    overallIndex: s.baseFeatures[BASE_FEATURE_NAMES.indexOf('overallIndex')],
    win: s.win,
    tanshoPayout: s.tanshoPayout,
  }))

  const testByRace = new Map<string, EvalSample[]>()
  for (const s of testSamples) {
    if (!testByRace.has(s.raceKey)) testByRace.set(s.raceKey, [])
    testByRace.get(s.raceKey)!.push(s)
  }

  let modelAttempts = 0
  let modelHits = 0
  let modelStake = 0
  let modelPayout = 0
  let baselineAttempts = 0
  let baselineHits = 0
  let baselineStake = 0
  let baselinePayout = 0

  for (const horses of testByRace.values()) {
    if (horses.length < 3) continue

    const modelScores = horses.map((h) => predict(standardize(h.features, mean, std), weights, bias))
    const modelTop = horses[modelScores.indexOf(Math.max(...modelScores))]
    modelAttempts += 1
    modelStake += 100
    modelPayout += modelTop.tanshoPayout
    if (modelTop.win) modelHits += 1

    const baseTop = horses[horses.map((h) => h.overallIndex).indexOf(Math.max(...horses.map((h) => h.overallIndex)))]
    baselineAttempts += 1
    baselineStake += 100
    baselinePayout += baseTop.tanshoPayout
    if (baseTop.win) baselineHits += 1
  }

  const modelHitRate = Math.round((modelHits / modelAttempts) * 1000) / 10
  const modelReturn = Math.round((modelPayout / modelStake) * 1000) / 10
  const baseHitRate = Math.round((baselineHits / baselineAttempts) * 1000) / 10
  const baseReturn = Math.round((baselinePayout / baselineStake) * 1000) / 10

  console.log('\n=== テストデータ(直近20%、学習に未使用)での単勝本命1点の回収率比較 ===')
  console.log(`現行(総合指数のみ): 試行${baselineAttempts} 的中率${baseHitRate}% 回収率${baseReturn}%`)
  console.log(`新モデル(ロジスティック回帰+血統): 試行${modelAttempts} 的中率${modelHitRate}% 回収率${modelReturn}%`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
