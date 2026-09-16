// 「固いレース」を独自に定義して検証する。
//
// 既存の定義(JRDBの確信度ラベル、市場の1番人気-2番人気差)は、どちらも「1位と2位の差」しか見ていない。
// これでは「2頭が抜けている」のか「1頭だけ抜けている」のかを区別できず、粗すぎる。
//
// 本スクリプトでは、レースの固さを5つの観点から測る:
//   1) 集中度        : 最終オッズ由来確率のハーフィンダール指数(Σp²)。1頭突出なら高く、横並びなら低い
//   2) 階層の深さ    : 指数1位と3位の確率差。2頭抜けなのか1頭だけなのかを捉える
//   3) 市場の落ち着き : 前日→最終のオッズ変動の平均(小さいほど市場が納得している)。TYBがあって初めて測れる
//   4) 頭数          : 少ないほど荒れにくい
//   5) 指数と市場の一致: JRDBと市場が同じ序列を見ているか(順位相関)
//
// まず各指標を単独で検証し、効いたものだけを合成して「固さスコア」を作る。
// 土台は現時点の最良戦略(最終オッズのエッジ × 血統上位30%)。
// 実行: npx tsx scripts/jrdb-solidity-score.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseTybBuffer, parseUkcBuffer, jrdbFileDate, type KyiRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const FOLDS = 5
const SOFTMAX_TEMPERATURE = 8
const SHRINK = { sire: 80, surface: 120, going: 150, distance: 150 }
const BASE_EDGE = 16 // 土台のエッジ閾値(サンプルを確保するため+20ptより緩める)

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
function distanceBucket(d: number): string {
  if (d <= 1400) return 'sprint'
  if (d <= 1800) return 'mile'
  if (d <= 2200) return 'middle'
  return 'long'
}

async function listDatesWithTyb(): Promise<Date[]> {
  const dir = path.join(DATA_DIR, 'Tyb')
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const dates: Date[] = []
  for (const f of files) {
    const m = f.match(/^TYB(\d{2})(\d{2})(\d{2})\.txt$/)
    if (!m) continue
    dates.push(jrdbFileDate(m[1], m[2], m[3]))
  }
  return dates.sort((a, b) => a.getTime() - b.getTime()).filter((d) => d < new Date())
}

// 順位相関(スピアマン)。指数と市場が同じ序列を見ているかを測る。
function rankCorrelation(a: number[], b: number[]): number {
  const n = a.length
  if (n < 3) return 0
  const rank = (arr: number[]) => {
    const idx = arr.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v)
    const r = new Array(n).fill(0)
    idx.forEach((x, pos) => (r[x.i] = pos + 1))
    return r
  }
  const ra = rank(a)
  const rb = rank(b)
  const d2 = ra.reduce((s, v, i) => s + (v - rb[i]) ** 2, 0)
  return 1 - (6 * d2) / (n * (n * n - 1))
}

type Row = {
  fold: number
  sire: string
  surfaceKey: string
  goingKey: string
  distKey: string
  edgeFinal: number
  // レース単位の固さ指標
  concentration: number // 集中度(Σp²)
  depth: number // 指数1位と3位の差(%pt)
  calmness: number // オッズ変動の平均(小さいほど落ち着いている)
  fieldSize: number
  agreement: number // 指数と市場の順位相関
  win: boolean
  payout: number
}

async function collectRows(): Promise<Row[]> {
  const dates = await listDatesWithTyb()
  const foldSize = Math.floor(dates.length / FOLDS)
  const foldOf = new Map<string, number>()
  dates.forEach((d, i) => foldOf.set(toYymmdd(d), Math.min(Math.floor(i / foldSize), FOLDS - 1)))

  const rows: Row[] = []
  let processed = 0

  for (const date of dates) {
    const d8 = toYymmdd(date)
    const fold = foldOf.get(d8)!
    let kyiBuf: Buffer
    let sedBuf: Buffer
    let tybBuf: Buffer
    try {
      kyiBuf = await fs.readFile(path.join(DATA_DIR, 'Kyi', `KYI${d8}.txt`))
      sedBuf = await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${d8}.txt`))
      tybBuf = await fs.readFile(path.join(DATA_DIR, 'Tyb', `TYB${d8}.txt`))
    } catch {
      continue
    }
    let ukcByKetto: Map<string, UkcRow>
    try {
      const ukcRows = parseUkcBuffer(await fs.readFile(path.join(DATA_DIR, 'Ukc', `UKC${d8}.txt`)))
      ukcByKetto = new Map(ukcRows.map((r) => [str(r.kettoNumber), r]))
    } catch {
      continue
    }

    const kyiRows = parseKyiBuffer(kyiBuf)
    const sedRows = parseSedBuffer(sedBuf)
    const tybMap = new Map(parseTybBuffer(tybBuf).map((t) => [`${t.venueCode}-${t.raceNumber}-${t.umaban}`, t]))

    const grouped = new Map<string, KyiRow[]>()
    for (const r of kyiRows) {
      const key = `${r.venueCode}-${r.raceNumber}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(r)
    }

    for (const horses of grouped.values()) {
      if (horses.length < 3) continue
      const venueCode = String(horses[0].venueCode)
      const raceNumber = Number(horses[0].raceNumber)

      const ourProbs = softmaxProbabilities(
        horses.map((h) => num(h.overallIndex)),
        SOFTMAX_TEMPERATURE,
      )
      const finalOdds = horses.map((h) => {
        const t = tybMap.get(`${venueCode}-${raceNumber}-${num(h.umaban)}`)
        return t ? num(t.finalOdds) : 0
      })
      if (finalOdds.some((o) => o <= 0)) continue
      const rawFinal = finalOdds.map((o) => 1 / o)
      const sumFinal = rawFinal.reduce((s, v) => s + v, 0)
      const probFinal = rawFinal.map((v) => v / sumFinal)

      // --- レースの固さを5観点で算出 ---
      // 1) 集中度: 1頭が突出しているほど大きい
      const concentration = probFinal.reduce((s, p) => s + p * p, 0)
      // 2) 階層の深さ: 指数1位と3位の差。2頭抜けなら小さく、1頭だけ抜けていれば大きい
      const sortedOur = [...ourProbs].sort((a, b) => b - a)
      const depth = (sortedOur[0] - (sortedOur[2] ?? 0)) * 100
      // 3) 市場の落ち着き: 前日→最終の変動の平均(小さいほど落ち着いている)
      let driftSum = 0
      let driftCount = 0
      for (let i = 0; i < horses.length; i++) {
        const before = num(horses[i].baseOdds)
        if (before > 0 && finalOdds[i] > 0) {
          driftSum += Math.abs(Math.log(finalOdds[i] / before))
          driftCount++
        }
      }
      const calmness = driftCount > 0 ? driftSum / driftCount : 999
      // 4) 頭数
      const fieldSize = horses.length
      // 5) 指数と市場の一致度
      const agreement = rankCorrelation(ourProbs, probFinal)

      for (let i = 0; i < horses.length; i++) {
        const h = horses[i]
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(h.umaban),
        )
        if (!sed) continue
        const ukc = ukcByKetto.get(str(h.kettoNumber))
        if (!ukc) continue
        const sire = str(ukc.sireName)
        const trackCode = num(sed.trackCode)
        const distance = num(sed.distance)
        const going = num(sed.trackCondition)
        if (!sire || !trackCode || !distance) continue

        const edgeFinal = (ourProbs[i] - probFinal[i]) * 100
        if (edgeFinal < BASE_EDGE) continue // 土台の条件を満たす馬だけ保持(メモリ節約)

        rows.push({
          fold,
          sire,
          surfaceKey: `${sire}|${trackCode}`,
          goingKey: going ? `${sire}|${going}` : '',
          distKey: `${sire}|${distanceBucket(distance)}`,
          edgeFinal,
          concentration,
          depth,
          calmness,
          fieldSize,
          agreement,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
        })
      }
    }
    processed++
    if (processed % 300 === 0) console.log(`  ...${processed}/${dates.length}日 (${rows.length.toLocaleString()}件)`)
  }
  return rows
}

type Layer = { name: string; key: keyof Row; shrink: number }
const LAYERS: Layer[] = [
  { name: '父馬', key: 'sire', shrink: SHRINK.sire },
  { name: '父×馬場', key: 'surfaceKey', shrink: SHRINK.surface },
  { name: '父×馬場状態', key: 'goingKey', shrink: SHRINK.going },
  { name: '父×距離帯', key: 'distKey', shrink: SHRINK.distance },
]

function buildModel(train: Row[]) {
  const globalMean = train.length > 0 ? (train.reduce((s, r) => s + r.payout, 0) / (train.length * 100)) * 100 : 0
  const predicted = new Array(train.length).fill(globalMean)
  const tables = new Map<string, Map<string, number>>()
  for (const layer of LAYERS) {
    const resid = new Map<string, { sum: number; n: number }>()
    for (let i = 0; i < train.length; i++) {
      const k = train[i][layer.key] as string
      if (!k) continue
      const cur = resid.get(k) ?? { sum: 0, n: 0 }
      cur.sum += train[i].payout - predicted[i]
      cur.n += 1
      resid.set(k, cur)
    }
    const effect = new Map<string, number>()
    for (const [k, { sum, n }] of resid) effect.set(k, (sum / n) * (n / (n + layer.shrink)))
    tables.set(layer.name, effect)
    for (let i = 0; i < train.length; i++) {
      const k = train[i][layer.key] as string
      if (k) predicted[i] += effect.get(k) ?? 0
    }
  }
  return (r: Row): number => {
    let v = globalMean
    for (const layer of LAYERS) {
      const k = r[layer.key] as string
      if (k) v += tables.get(layer.name)!.get(k) ?? 0
    }
    return v
  }
}

type Counter = { bets: number; wins: number; payout: number }
const newCounter = (): Counter => ({ bets: 0, wins: 0, payout: 0 })
const roiOf = (c: Counter) => (c.bets > 0 ? (c.payout / (c.bets * 100)) * 100 : 0)
function addTo(c: Counter, r: Row) {
  c.bets += 1
  if (r.win) c.wins += 1
  c.payout += r.payout
}

// 各指標を5分位に分けて、テスト期間の回収率を見る
function quintileReport(label: string, rows: { r: Row; v: number }[], ascending: boolean) {
  const sorted = [...rows].sort((a, b) => (ascending ? a.v - b.v : b.v - a.v))
  const buckets = Array.from({ length: 5 }, newCounter)
  sorted.forEach((x, i) => {
    const b = Math.min(Math.floor((i / sorted.length) * 5), 4)
    addTo(buckets[b], x.r)
  })
  const vals = buckets.map((b) => `${roiOf(b).toFixed(1)}%(${b.bets})`)
  const diff = roiOf(buckets[0]) - roiOf(buckets[4])
  console.log(`  ${label.padEnd(22)}\t${vals.join(' / ')}\t差${diff.toFixed(1)}pt`)
  return diff
}

async function main() {
  console.log('=== 独自の「固さ」指標でレースを絞る ===')
  console.log(`土台: 最終オッズのエッジ+${BASE_EDGE}pt以上 × 血統上位30%(4層モデル)\n`)

  const rows = await collectRows()
  console.log(`\n土台の母集団: ${rows.length.toLocaleString()}件\n`)

  // 血統上位N%に絞ったテストデータを、fold横断で集める。
  // 血統モデルは「エッジ条件を満たす馬」だけで学習する(=エッジ馬の中でどの血統が儲かるか)。
  const collected: Row[] = []
  const foldDetail: Counter[] = []
  const TOP_PCT = 0.3
  for (let testFold = 1; testFold < FOLDS; testFold++) {
    const train = rows.filter((r) => r.fold < testFold)
    const test = rows.filter((r) => r.fold === testFold)
    if (train.length === 0 || test.length === 0) continue
    const score = buildModel(train)
    const scored = test.map((r) => ({ r, s: score(r) }))
    const sorted = scored.map((x) => x.s).sort((a, b) => a - b)
    const cut = sorted[Math.floor(sorted.length * (1 - TOP_PCT))]
    const fc = newCounter()
    for (const { r, s } of scored) {
      if (s < cut) continue
      collected.push(r)
      addTo(fc, r)
    }
    foldDetail.push(fc)
  }
  console.log(`血統上位30%まで絞った後: ${collected.length.toLocaleString()}件`)
  const baseC = newCounter()
  for (const r of collected) addTo(baseC, r)
  console.log(`この時点の回収率: ${roiOf(baseC).toFixed(1)}%`)
  console.log(`  fold別: ${foldDetail.map((c) => `${roiOf(c).toFixed(0)}%(${c.bets})`).join(' / ')}\n`)

  // 血統の絞り込み幅を変えた場合も見る(絞るほど良くなるのか)
  console.log('【血統の絞り込み幅を変えた場合】')
  for (const pct of [1.0, 0.5, 0.3, 0.2, 0.1]) {
    const total = newCounter()
    const perFold: Counter[] = []
    for (let testFold = 1; testFold < FOLDS; testFold++) {
      const train = rows.filter((r) => r.fold < testFold)
      const test = rows.filter((r) => r.fold === testFold)
      if (train.length === 0 || test.length === 0) continue
      const score = buildModel(train)
      const scored = test.map((r) => ({ r, s: score(r) }))
      const sorted = scored.map((x) => x.s).sort((a, b) => a - b)
      const cut = pct >= 1 ? -Infinity : sorted[Math.floor(sorted.length * (1 - pct))]
      const fc = newCounter()
      for (const { r, s } of scored) {
        if (s < cut) continue
        addTo(total, r)
        addTo(fc, r)
      }
      perFold.push(fc)
    }
    const label = pct >= 1 ? '血統フィルタなし' : `血統上位${Math.round(pct * 100)}%`
    console.log(
      `  ${label.padEnd(16)}\t試行${String(total.bets).padStart(5)}\t回収率${roiOf(total).toFixed(1)}%\tfold別: ${perFold.map((c) => `${roiOf(c).toFixed(0)}%(${c.bets})`).join(' / ')}`,
    )
  }
  console.log('')

  console.log('【各指標を5分位に分けたときの回収率(左が「固い」側)】')
  quintileReport('集中度(高いほど固い)', collected.map((r) => ({ r, v: r.concentration })), false)
  quintileReport('階層の深さ(1位-3位)', collected.map((r) => ({ r, v: r.depth })), false)
  quintileReport('市場の落ち着き(変動小)', collected.map((r) => ({ r, v: r.calmness })), true)
  quintileReport('頭数(少ないほど固い)', collected.map((r) => ({ r, v: r.fieldSize })), true)
  quintileReport('指数と市場の一致度', collected.map((r) => ({ r, v: r.agreement })), false)


}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
