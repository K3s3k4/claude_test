// 血統検証の最終確認: 最良の血統モデル(4層・回収率ベース)と、最終オッズのエッジを組み合わせる。
//
// ここまでで分かったこと:
//   - 血統は回収率で測れば持続性がある(全馬71% → 血統上位20%で82%)。ただし血統だけでは82-83%が天井。
//   - 最終オッズのエッジ単独はエッジ+16ptで87.4%。
//   - 勝率ベースの血統フィルタをエッジに重ねると悪化した(5.2節)。回収率ベースなら結果が変わるか?
//
// 2つは「市場のズレ」という同じ源泉を狙っているため、冗長で上乗せが出ない可能性がある。
// それを確かめるのが本スクリプトの目的。
// 実行: npx tsx scripts/jrdb-pedigree-plus-edge.ts
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
function fmt(c: Counter) {
  const hitRate = c.bets > 0 ? ((c.wins / c.bets) * 100).toFixed(1) : '0'
  const roi = c.bets > 0 ? ((c.payout / (c.bets * 100)) * 100).toFixed(1) : '0'
  return `試行${String(c.bets).padStart(6)}\t的中率${hitRate}%\t回収率${roi}%`
}

async function main() {
  console.log('=== 血統モデル(4層・回収率ベース)× 最終オッズのエッジ ===\n')
  const rows = await collectRows()
  console.log(`\n対象: ${rows.length.toLocaleString()}頭\n`)

  const edgeThresholds = [8, 12, 16, 20]
  const pedigreeTops = [0, 50, 30, 20, 10] // 0=血統フィルタなし。上位N%に絞る

  // [エッジ閾値][血統上位N%] のカウンタ
  const cells = new Map<string, Counter>()
  for (const e of edgeThresholds) for (const p of pedigreeTops) cells.set(`${e}|${p}`, newCounter())
  const pedigreeOnly = new Map<number, Counter>(pedigreeTops.map((p) => [p, newCounter()]))
  // 小サンプルの数値を信用してよいか判断するため、fold別の内訳も残す
  const cellsByFold = new Map<string, Counter[]>()
  for (const e of edgeThresholds) for (const p of pedigreeTops) cellsByFold.set(`${e}|${p}`, [])

  for (let testFold = 1; testFold < FOLDS; testFold++) {
    const train = rows.filter((r) => r.fold < testFold)
    const test = rows.filter((r) => r.fold === testFold)
    if (train.length === 0 || test.length === 0) continue

    const score = buildModel(train)
    const scored = test.map((r) => ({ r, s: score(r) }))
    const sortedScores = scored.map((x) => x.s).sort((a, b) => a - b)
    const cutFor = (p: number) => (p === 0 ? -Infinity : sortedScores[Math.floor(sortedScores.length * (1 - p / 100))])

    for (const p of pedigreeTops) {
      const cut = cutFor(p)
      const foldCells = new Map<number, Counter>(edgeThresholds.map((e) => [e, newCounter()]))
      for (const { r, s } of scored) {
        if (s < cut) continue
        addTo(pedigreeOnly.get(p)!, r)
        for (const e of edgeThresholds) {
          if (r.edgeFinal >= e) {
            addTo(cells.get(`${e}|${p}`)!, r)
            addTo(foldCells.get(e)!, r)
          }
        }
      }
      for (const e of edgeThresholds) cellsByFold.get(`${e}|${p}`)!.push(foldCells.get(e)!)
    }
  }

  console.log('【血統モデル単独(エッジ条件なし)】')
  for (const p of pedigreeTops) {
    const label = p === 0 ? '全馬' : `血統上位${p}%`
    console.log(`  ${label.padEnd(12)}\t${fmt(pedigreeOnly.get(p)!)}`)
  }

  console.log('\n【最終オッズのエッジ × 血統モデル】')
  for (const e of edgeThresholds) {
    console.log(`\n  エッジ+${e}pt以上:`)
    for (const p of pedigreeTops) {
      const label = p === 0 ? '血統フィルタなし' : `血統上位${p}%のみ`
      console.log(`    ${label.padEnd(16)}\t${fmt(cells.get(`${e}|${p}`)!)}`)
    }
  }

  // 小サンプルの高回収率がfold間で再現しているかを確認する(1foldだけが押し上げていないか)
  console.log('\n【fold別の回収率(一貫性の確認)】')
  for (const e of [16, 20]) {
    console.log(`\n  エッジ+${e}pt以上:`)
    for (const p of pedigreeTops) {
      const label = p === 0 ? '血統フィルタなし' : `血統上位${p}%のみ`
      const detail = cellsByFold
        .get(`${e}|${p}`)!
        .map((c) => {
          const roi = c.bets > 0 ? ((c.payout / (c.bets * 100)) * 100).toFixed(0) : '-'
          return `${roi}%(${c.bets})`
        })
        .join(' / ')
      console.log(`    ${label.padEnd(16)}\t${detail}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
