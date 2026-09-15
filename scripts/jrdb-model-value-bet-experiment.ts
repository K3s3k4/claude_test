// これまでの2つの知見を統合する実験:
//   1) 単純に「モデルの1位を常に買う」戦略は回収率で市場に勝てない(市場効率が高いため)
//   2) 「市場が見落としている分だけ買う」バリューベッティングは有望(単勝edge>=4pt→83.3%など)
// →市場特徴量を除いたロジスティック回帰モデル(JRDB指数+血統のみ)の推定確率を「自分の見立て」とし、
//   市場のオッズ由来確率との差(エッジ)がしきい値を超えた馬だけに賭けるとどうなるかを検証する。
// 実行: npx tsx scripts/jrdb-model-value-bet-experiment.ts
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

// 市場特徴量(marketLogProb・basePopularity)は含めない: 市場と独立な「自分の見立て」を作るため
const FEATURE_NAMES = [
  'idm',
  'jockeyIndex',
  'infoIndex',
  'trainingIndex',
  'stableIndex',
  'overallIndex',
  'headCount',
  ...Array.from({ length: 8 }, (_, i) => `waku${i + 1}`),
  ...VENUE_CODES.map((c) => `venue${c}`),
  'sireWinRate',
  'damSireWinRate',
]

type RawSample = {
  raceKey: string
  venueCode: string
  raceNumber: number
  umaban: number
  baseFeatures: number[]
  sireName: string
  damSireName: string
  odds: number
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
      // UKC未取得の日は血統情報なしで進める
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
          headCount,
          ...wakuOneHot,
          ...venueOneHot,
        ]

        samples.push({
          raceKey: `${dateStr8}-${key}`,
          venueCode,
          raceNumber,
          umaban,
          baseFeatures,
          sireName,
          damSireName,
          odds: num(h.baseOdds),
          win: num(sed.tanshoPayout) > 0,
          tanshoPayout: num(sed.tanshoPayout),
        })
      }
    }
  }
  return samples
}

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
function predictProb(features: number[], weights: number[], bias: number): number {
  const z = features.reduce((s, v, j) => s + v * weights[j], bias)
  return sigmoid(z)
}

async function main() {
  console.log('データセットを構築中...')
  const rawSamples = await buildDataset()
  console.log(`サンプル数: ${rawSamples.length}(${new Set(rawSamples.map((s) => s.raceKey)).size}レース)\n`)

  const raceKeys = [...new Set(rawSamples.map((s) => s.raceKey))].sort()
  const splitIdx = Math.floor(raceKeys.length * 0.8)
  const trainRaceKeys = new Set(raceKeys.slice(0, splitIdx))
  const trainRaw = rawSamples.filter((s) => trainRaceKeys.has(s.raceKey))
  const testRaw = rawSamples.filter((s) => !trainRaceKeys.has(s.raceKey))
  console.log(`train: ${trainRaw.length}件 / test: ${testRaw.length}件\n`)

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

  console.log('学習中(市場特徴量なし)...')
  const { weights, bias } = trainLogisticRegression(X, trainY, 300, 0.3, 0.001)
  console.log('学習完了\n')

  type EvalSample = { raceKey: string; features: number[]; overallIndex: number; odds: number; win: boolean; tanshoPayout: number }
  const testSamples: EvalSample[] = testRaw.map((s) => ({
    raceKey: s.raceKey,
    features: withPedigreeFeatures(s),
    overallIndex: s.baseFeatures[FEATURE_NAMES.indexOf('overallIndex')],
    odds: s.odds,
    win: s.win,
    tanshoPayout: s.tanshoPayout,
  }))

  const testByRace = new Map<string, EvalSample[]>()
  for (const s of testSamples) {
    if (!testByRace.has(s.raceKey)) testByRace.set(s.raceKey, [])
    testByRace.get(s.raceKey)!.push(s)
  }

  const edgeThresholds = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.16, 0.18, 0.2, 0.25, 0.3]
  const modelResults: Record<number, { attempts: number; hits: number; stake: number; payout: number }> = {}
  const oiResults: Record<number, { attempts: number; hits: number; stake: number; payout: number }> = {}
  for (const t of edgeThresholds) {
    modelResults[t] = { attempts: 0, hits: 0, stake: 0, payout: 0 }
    oiResults[t] = { attempts: 0, hits: 0, stake: 0, payout: 0 }
  }
  const baseline = { attempts: 0, hits: 0, stake: 0, payout: 0 }

  for (const horses of testByRace.values()) {
    if (horses.length < 3) continue

    // モデル確率(市場を見ていない予測)をレース内でsoftmax正規化(相対的な確信度として使う)
    const rawScores = horses.map((h) => predictProb(standardize(h.features, mean, std), weights, bias))
    const scoreSum = rawScores.reduce((s, v) => s + v, 0)
    const modelProbs = scoreSum > 0 ? rawScores.map((v) => v / scoreSum) : rawScores

    // 参考: overallIndexのみのsoftmax確率(既存のバリューベット実験と同条件)
    const T = 8
    const expScores = horses.map((h) => Math.exp(num(h.overallIndex) / T))
    const expSum = expScores.reduce((s, v) => s + v, 0)
    const oiProbs = expScores.map((v) => v / expSum)

    const rawMarket = horses.map((h) => (h.odds > 0 ? 1 / h.odds : 0))
    const marketSum = rawMarket.reduce((s, v) => s + v, 0)
    const marketProbs = marketSum > 0 ? rawMarket.map((v) => v / marketSum) : rawMarket

    const topIdx = modelProbs.indexOf(Math.max(...modelProbs))
    const topHorse = horses[topIdx]
    baseline.attempts += 1
    baseline.stake += 100
    baseline.payout += topHorse.tanshoPayout
    if (topHorse.win) baseline.hits += 1

    for (let i = 0; i < horses.length; i++) {
      if (horses[i].odds <= 0) continue
      const h = horses[i]

      const modelEdge = modelProbs[i] - marketProbs[i]
      for (const t of edgeThresholds) {
        if (modelEdge < t) continue
        const res = modelResults[t]
        res.attempts += 1
        res.stake += 100
        res.payout += h.tanshoPayout
        if (h.win) res.hits += 1
      }

      const oiEdge = oiProbs[i] - marketProbs[i]
      for (const t of edgeThresholds) {
        if (oiEdge < t) continue
        const res = oiResults[t]
        res.attempts += 1
        res.stake += 100
        res.payout += h.tanshoPayout
        if (h.win) res.hits += 1
      }
    }
  }

  const fmt = (r: { attempts: number; hits: number; stake: number; payout: number }) => {
    const hitRate = r.attempts > 0 ? Math.round((r.hits / r.attempts) * 1000) / 10 : 0
    const returnRate = r.stake > 0 ? Math.round((r.payout / r.stake) * 1000) / 10 : 0
    return `試行${r.attempts}\t的中${r.hits}\t的中率${hitRate}%\t回収率${returnRate}%`
  }

  console.log('=== 常にモデル1位(参考) ===')
  console.log(fmt(baseline))

  console.log('\n=== バリューベット: 新モデル(市場特徴量なし)の確率 vs 市場確率 ===')
  for (const t of edgeThresholds) {
    console.log(`edge>=${(t * 100).toFixed(0)}pt\t${fmt(modelResults[t])}`)
  }

  console.log('\n=== バリューベット(参考・既存手法): overallIndexのみ vs 市場確率 ===')
  for (const t of edgeThresholds) {
    console.log(`edge>=${(t * 100).toFixed(0)}pt\t${fmt(oiResults[t])}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
