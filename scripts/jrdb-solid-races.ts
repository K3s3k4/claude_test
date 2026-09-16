// 「固いレース」に絞った場合の回収率を検証する。
//
// 現時点の最良戦略は「最終オッズのエッジ+20pt × 血統上位30% = 91.4%」。
// ここにレース単位の「固さ」条件を重ねて100%に届くかを見る。
//
// 固さの定義を2通り用意する:
//   A) 市場の確信度 = 最終オッズ由来の確率における1番人気と2番人気の差(客観的事実)
//   B) JRDBの確信度 = 総合指数のsoftmax確率における1位と2位の差(「堅い」ラベルの算出根拠)
//
// Bは我々がエッジ計算に使っている指数そのものから作られるため、エッジと情報が重複する可能性がある。
// Aは市場側の事実なので、指数とは独立した情報になりうる。その差も含めて確認する。
// 実行: npx tsx scripts/jrdb-solid-races.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseTybBuffer, parseUkcBuffer, jrdbFileDate, type KyiRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const FOLDS = 5
const SOFTMAX_TEMPERATURE = 8
const SHRINK = { sire: 80, surface: 120, going: 150, distance: 150 }

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

type Row = {
  fold: number
  sire: string
  surfaceKey: string
  goingKey: string
  distKey: string
  edgeFinal: number // 最終オッズ基準のエッジ(%pt)
  marketGap: number // レース単位: 最終オッズ由来の1番人気と2番人気の確率差(%pt)
  indexGap: number // レース単位: 総合指数softmaxの1位と2位の差(%pt)
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

      // レース単位の「固さ」を2通り算出
      const sortedMarket = [...probFinal].sort((a, b) => b - a)
      const marketGap = (sortedMarket[0] - (sortedMarket[1] ?? 0)) * 100
      const sortedIndex = [...ourProbs].sort((a, b) => b - a)
      const indexGap = (sortedIndex[0] - (sortedIndex[1] ?? 0)) * 100

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

        rows.push({
          fold,
          sire,
          surfaceKey: `${sire}|${trackCode}`,
          goingKey: going ? `${sire}|${going}` : '',
          distKey: `${sire}|${distanceBucket(distance)}`,
          edgeFinal: (ourProbs[i] - probFinal[i]) * 100,
          marketGap,
          indexGap,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
        })
      }
    }
    processed++
    if (processed % 300 === 0) console.log(`  ...${processed}/${dates.length}日 (${rows.length.toLocaleString()}頭)`)
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
function addTo(c: Counter, r: Row) {
  c.bets += 1
  if (r.win) c.wins += 1
  c.payout += r.payout
}
const roiOf = (c: Counter) => (c.bets > 0 ? (c.payout / (c.bets * 100)) * 100 : 0)
function fmt(c: Counter) {
  const hit = c.bets > 0 ? ((c.wins / c.bets) * 100).toFixed(1) : '0'
  return `試行${String(c.bets).padStart(5)}\t的中率${hit}%\t回収率${roiOf(c).toFixed(1)}%`
}

async function main() {
  console.log('=== 「固いレース」に絞った場合の回収率 ===')
  console.log('土台: 最終オッズのエッジ × 血統上位30%(4層モデル)\n')

  const rows = await collectRows()
  console.log(`\n対象: ${rows.length.toLocaleString()}頭\n`)

  const edges = [16, 20]
  // 固さの条件。marketGap/indexGap はレース単位の値
  const solids: { name: string; test: (r: Row) => boolean }[] = [
    { name: '条件なし(全レース)', test: () => true },
    { name: '市場gap>=10pt', test: (r) => r.marketGap >= 10 },
    { name: '市場gap>=15pt', test: (r) => r.marketGap >= 15 },
    { name: '市場gap>=20pt', test: (r) => r.marketGap >= 20 },
    { name: 'JRDB指数gap>=12pt(堅い)', test: (r) => r.indexGap >= 12 },
    { name: 'JRDB指数gap>=20pt', test: (r) => r.indexGap >= 20 },
    { name: '市場gap>=10 かつ 指数gap>=12', test: (r) => r.marketGap >= 10 && r.indexGap >= 12 },
  ]

  const cells = new Map<string, Counter>()
  const byFold = new Map<string, Counter[]>()
  for (const e of edges) for (const s of solids) {
    cells.set(`${e}|${s.name}`, newCounter())
    byFold.set(`${e}|${s.name}`, [])
  }

  for (let testFold = 1; testFold < FOLDS; testFold++) {
    const train = rows.filter((r) => r.fold < testFold)
    const test = rows.filter((r) => r.fold === testFold)
    if (train.length === 0 || test.length === 0) continue

    const score = buildModel(train)
    const scored = test.map((r) => ({ r, s: score(r) }))
    const sorted = scored.map((x) => x.s).sort((a, b) => a - b)
    const cut30 = sorted[Math.floor(sorted.length * 0.7)] // 血統上位30%の境界

    for (const e of edges) {
      for (const s of solids) {
        const c = newCounter()
        for (const { r, s: sc } of scored) {
          if (sc < cut30) continue // 血統上位30%
          if (r.edgeFinal < e) continue
          if (!s.test(r)) continue
          addTo(cells.get(`${e}|${s.name}`)!, r)
          addTo(c, r)
        }
        byFold.get(`${e}|${s.name}`)!.push(c)
      }
    }
  }

  for (const e of edges) {
    console.log(`\n【エッジ+${e}pt × 血統上位30%】`)
    for (const s of solids) {
      console.log(`  ${s.name.padEnd(26)}\t${fmt(cells.get(`${e}|${s.name}`)!)}`)
    }
    console.log('\n  fold別の回収率:')
    for (const s of solids) {
      const detail = byFold
        .get(`${e}|${s.name}`)!
        .map((c) => (c.bets > 0 ? `${roiOf(c).toFixed(0)}%(${c.bets})` : '-'))
        .join(' / ')
      console.log(`  ${s.name.padEnd(26)}\t${detail}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
