// 単勝で構築した最良戦略(最終オッズのエッジ × 血統 × JRDB指数の確信度)を、複勝に適用する。
//
// 狙い: 単勝版の最良は98.9%だが試行313件・的中率33%と少なく、fold変動が30ptある。
// 複勝は的中率が3倍近くになるため、同じ条件でもfold変動が大幅に縮むはず。
// 「本当に100%を超えているのか」を判定できる精度が得られる可能性がある。
//
// 複勝特有の扱い:
//   - JRAルールで8頭以上なら3着まで、5〜7頭なら2着まで的中(4頭以下は複勝なし)
//   - したがって市場の複勝確率は合計が3(または2)になるよう正規化する
//   - 血統モデルも複勝の回収率で学習する(単勝の回収率ではない)
// 実行: npx tsx scripts/jrdb-fukusho-combined.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities, placeProbability } from '../server/probability'
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
// JRAの複勝は出走頭数で的中範囲が変わる
function placeSlots(fieldSize: number): number {
  if (fieldSize >= 8) return 3
  if (fieldSize >= 5) return 2
  return 0 // 4頭以下は複勝の発売が無い
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
  edgePlace: number // 複勝の最終オッズ基準エッジ(%pt)
  indexGap: number // レース単位: 指数1位と2位の勝率差(%pt)
  win: boolean // 複勝的中
  payout: number // 複勝払戻
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
      const slots = placeSlots(horses.length)
      if (slots === 0) continue
      const venueCode = String(horses[0].venueCode)
      const raceNumber = Number(horses[0].raceNumber)

      const winProbs = softmaxProbabilities(
        horses.map((h) => num(h.overallIndex)),
        SOFTMAX_TEMPERATURE,
      )
      // 我々の複勝確率(Harville法ベース)。3着までか2着までかで意味が変わるため、
      // 2着までのレースは「1位+2位」の確率に読み替える必要があるが、
      // placeProbabilityは3着までを前提としているので、頭数が少ないレースは除外して精度を保つ。
      if (slots !== 3) continue
      const ourPlace = horses.map((_, i) => placeProbability(i, winProbs))

      // 市場の複勝確率。複勝オッズの逆数は合計が約3(3着まで的中するため)になるので、
      // 控除率ぶんのふくらみを取り除いたうえで合計3に正規化する。
      const placeOdds = horses.map((h) => {
        const t = tybMap.get(`${venueCode}-${raceNumber}-${num(h.umaban)}`)
        return t ? num(t.finalPlaceOdds) : 0
      })
      if (placeOdds.some((o) => o <= 0)) continue
      const rawPlace = placeOdds.map((o) => 1 / o)
      const sumPlace = rawPlace.reduce((s, v) => s + v, 0)
      if (sumPlace <= 0) continue
      const marketPlace = rawPlace.map((v) => (v / sumPlace) * 3)

      const sortedWin = [...winProbs].sort((a, b) => b - a)
      const indexGap = (sortedWin[0] - (sortedWin[1] ?? 0)) * 100

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
          edgePlace: (ourPlace[i] - marketPlace[i]) * 100,
          indexGap,
          win: num(sed.fukushoPayout) > 0,
          payout: num(sed.fukushoPayout),
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

// 血統モデルは複勝の回収率で学習する(全馬を対象にして過学習を避ける)
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
function fmt(c: Counter) {
  const hit = c.bets > 0 ? ((c.wins / c.bets) * 100).toFixed(1) : '0'
  return `試行${String(c.bets).padStart(5)}\t的中率${hit}%\t回収率${roiOf(c).toFixed(1)}%`
}

async function main() {
  console.log('=== 複勝版: 最終オッズのエッジ × 血統 × JRDB指数の確信度 ===\n')
  const rows = await collectRows()
  console.log(`\n対象: ${rows.length.toLocaleString()}頭(8頭立て以上のレース)\n`)

  const edges = [10, 15, 20, 25, 30]
  const variants: { name: string; pedigree: number; indexGap: number }[] = [
    { name: '血統なし・確信度なし', pedigree: 1.0, indexGap: 0 },
    { name: '血統上位30%', pedigree: 0.3, indexGap: 0 },
    { name: '指数gap>=12のみ', pedigree: 1.0, indexGap: 12 },
    { name: '血統上位30% + 指数gap>=12', pedigree: 0.3, indexGap: 12 },
  ]

  const cells = new Map<string, Counter>()
  const byFold = new Map<string, Counter[]>()
  for (const e of edges) for (const v of variants) {
    cells.set(`${e}|${v.name}`, newCounter())
    byFold.set(`${e}|${v.name}`, [])
  }

  for (let testFold = 1; testFold < FOLDS; testFold++) {
    const train = rows.filter((r) => r.fold < testFold)
    const test = rows.filter((r) => r.fold === testFold)
    if (train.length === 0 || test.length === 0) continue

    const score = buildModel(train)
    const scored = test.map((r) => ({ r, s: score(r) }))
    const sortedScores = scored.map((x) => x.s).sort((a, b) => a - b)

    for (const e of edges) {
      for (const v of variants) {
        const cut = v.pedigree >= 1 ? -Infinity : sortedScores[Math.floor(sortedScores.length * (1 - v.pedigree))]
        const fc = newCounter()
        for (const { r, s } of scored) {
          if (r.edgePlace < e) continue
          if (s < cut) continue
          if (r.indexGap < v.indexGap) continue
          addTo(cells.get(`${e}|${v.name}`)!, r)
          addTo(fc, r)
        }
        byFold.get(`${e}|${v.name}`)!.push(fc)
      }
    }
  }

  for (const e of edges) {
    console.log(`\n【複勝エッジ+${e}pt以上】`)
    for (const v of variants) {
      const c = cells.get(`${e}|${v.name}`)!
      const detail = byFold
        .get(`${e}|${v.name}`)!
        .map((f) => (f.bets > 0 ? `${roiOf(f).toFixed(0)}%(${f.bets})` : '-'))
        .join(' / ')
      console.log(`  ${v.name.padEnd(26)}\t${fmt(c)}\tfold別: ${detail}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
