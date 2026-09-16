// 「血統だけをファクトに」した場合の月次回収率を出す。
//
// これまでの検証は全て「JRDB総合指数のバリューベット(エッジ+8pt以上)で母集団を作り、
// そこに血統フィルタを重ねる」形だった。本スクリプトはそうではなく、
// JRDB指数も市場オッズも一切使わず、血統だけで買い目を決めた場合の成績を測る。
//
// 選定方法: 各レースで「父馬×馬場適性(または父馬×距離帯適性)の過去勝率」が最も高い馬の単勝を1点買う。
// 勝率テーブルは対象月より前のデータのみから算出する(リーク防止)。
// 実行: npx tsx scripts/jrdb-pedigree-only-monthly.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { empiricalBayesShrink } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseUkcBuffer, jrdbFileDate, type KyiRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function distanceBucket(distance: number): string {
  if (distance <= 1400) return 'sprint'
  if (distance <= 1800) return 'mile'
  if (distance <= 2200) return 'middle'
  return 'long'
}

async function listKyiDates(): Promise<Date[]> {
  const dir = path.join(DATA_DIR, 'Kyi')
  const files = await fs.readdir(dir)
  const dates: Date[] = []
  for (const f of files) {
    const m = f.match(/^KYI(\d{2})(\d{2})(\d{2})\.txt$/)
    if (!m) continue
    dates.push(jrdbFileDate(m[1], m[2], m[3]))
  }
  return dates.sort((a, b) => a.getTime() - b.getTime())
}

// 1頭ぶんの「その日のレースでの血統キーと結果」
type HorseRow = {
  date: Date
  raceKey: string
  umaban: number
  horseName: string
  odds: number
  sireTrackKey: string
  sireDistKey: string
  win: boolean
  payout: number
  marketProb: number // 参考用(選定には使わない)
}

async function collectHorses(dates: Date[]): Promise<HorseRow[]> {
  const out: HorseRow[] = []
  for (const date of dates) {
    const dateStr8 = toYymmdd(date)
    let kyiBuf: Buffer
    let sedBuf: Buffer
    try {
      kyiBuf = await fs.readFile(path.join(DATA_DIR, 'Kyi', `KYI${dateStr8}.txt`))
      sedBuf = await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${dateStr8}.txt`))
    } catch {
      continue
    }
    let ukcByKetto: Map<string, UkcRow>
    try {
      const ukcRows = parseUkcBuffer(await fs.readFile(path.join(DATA_DIR, 'Ukc', `UKC${dateStr8}.txt`)))
      ukcByKetto = new Map(ukcRows.map((r) => [str(r.kettoNumber), r]))
    } catch {
      continue
    }

    const kyiRows = parseKyiBuffer(kyiBuf)
    const sedRows = parseSedBuffer(sedBuf)

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

      const rawMarket = horses.map((h) => {
        const odds = num(h.baseOdds)
        return odds > 0 ? 1 / odds : 0
      })
      const marketSum = rawMarket.reduce((s, v) => s + v, 0)

      for (let i = 0; i < horses.length; i++) {
        const h = horses[i]
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(h.umaban),
        )
        if (!sed) continue
        const ukc = ukcByKetto.get(str(h.kettoNumber))
        if (!ukc) continue
        const sireName = str(ukc.sireName)
        const trackCode = num(sed.trackCode)
        const distance = num(sed.distance)
        if (!sireName || !trackCode || !distance) continue

        out.push({
          date,
          raceKey: `${dateStr8}-${key}`,
          umaban: num(h.umaban),
          horseName: str(h.horseName),
          odds: num(h.baseOdds),
          sireTrackKey: `${sireName}|${trackCode}`,
          sireDistKey: `${sireName}|${distanceBucket(distance)}`,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
          marketProb: marketSum > 0 ? rawMarket[i] / marketSum : 0,
        })
      }
    }
  }
  return out
}

// 学習期間は10年超・延べ50万頭になるため、全頭を配列に保持するとメモリが尽きる。
// 日ごとに読み込んでは勝率カウンタだけを更新し、行データは即座に捨てるストリーム集計にする。
type RateAccumulator = {
  stats: Map<string, { wins: number; count: number }>
  total: number
  wins: number
}
function newAccumulator(): RateAccumulator {
  return { stats: new Map(), total: 0, wins: 0 }
}
function accumulate(acc: RateAccumulator, key: string, win: boolean) {
  const cur = acc.stats.get(key) ?? { wins: 0, count: 0 }
  cur.count += 1
  if (win) cur.wins += 1
  acc.stats.set(key, cur)
  acc.total += 1
  if (win) acc.wins += 1
}
function finalizeTable(acc: RateAccumulator) {
  const globalMean = acc.total > 0 ? acc.wins / acc.total : 0
  const table = new Map<string, number>()
  for (const [k, { wins, count }] of acc.stats) {
    table.set(k, empiricalBayesShrink((wins / count) * 100, count, globalMean * 100, 20) / 100)
  }
  return { table, globalMean }
}

// 学習期間を1日ずつ処理し、勝率テーブルだけを積み上げる(行データは保持しない)
async function buildTablesStreaming(dates: Date[]) {
  const trackAcc = newAccumulator()
  const distAcc = newAccumulator()
  let processed = 0
  for (const date of dates) {
    const rows = await collectHorses([date])
    for (const r of rows) {
      accumulate(trackAcc, r.sireTrackKey, r.win)
      accumulate(distAcc, r.sireDistKey, r.win)
    }
    processed++
    if (processed % 200 === 0) console.log(`  ...${processed}/${dates.length}日 処理済み`)
  }
  return { track: finalizeTable(trackAcc), dist: finalizeTable(distAcc), horseCount: trackAcc.total }
}

type Bet = { win: boolean; payout: number }
function fmt(bets: Bet[]) {
  const attempts = bets.length
  const hits = bets.filter((b) => b.win).length
  const stake = attempts * 100
  const payout = bets.reduce((s, b) => s + b.payout, 0)
  const hitRate = attempts > 0 ? Math.round((hits / attempts) * 1000) / 10 : 0
  const returnRate = stake > 0 ? Math.round((payout / stake) * 1000) / 10 : 0
  return `試行${attempts}\t的中${hits}\t的中率${hitRate}%\t回収率${returnRate}%`
}

async function main() {
  console.log('=== 血統だけをファクトにした場合の月次回収率 ===')
  console.log('JRDB指数・市場オッズは一切使わず、各レースで「父系の適性勝率が最も高い馬」の単勝1点\n')

  const allDates = await listKyiDates()
  const cutoff = new Date(2026, 6, 1) // 2026-07-01
  const trainDates = allDates.filter((d) => d < cutoff)
  const julyDates = allDates.filter((d) => d >= new Date(2026, 6, 1) && d < new Date(2026, 7, 1))
  const augDates = allDates.filter((d) => d >= new Date(2026, 7, 1) && d < new Date(2026, 8, 1))

  console.log(`学習: 〜2026年6月末(${trainDates.length}日) / 7月(${julyDates.length}日) / 8月(${augDates.length}日)\n`)

  console.log('学習データを集計中...')
  const { track: trackTbl, dist: distTbl, horseCount } = await buildTablesStreaming(trainDates)
  console.log(`  学習対象: ${horseCount.toLocaleString()}頭`)
  console.log(`  父馬×馬場: ${trackTbl.table.size}種類 / 父馬×距離帯: ${distTbl.table.size}種類`)
  console.log(`  全体平均勝率: ${(trackTbl.globalMean * 100).toFixed(1)}%\n`)

  for (const [label, dates] of [
    ['7月', julyDates],
    ['8月', augDates],
  ] as const) {
    const rows = await collectHorses(dates)
    const byRace = new Map<string, HorseRow[]>()
    for (const r of rows) {
      const list = byRace.get(r.raceKey) ?? []
      list.push(r)
      byRace.set(r.raceKey, list)
    }

    const pickBy = (key: 'sireTrackKey' | 'sireDistKey', tbl: Map<string, number>, mean: number): Bet[] => {
      const bets: Bet[] = []
      for (const horses of byRace.values()) {
        let best: HorseRow | null = null
        let bestRate = -1
        for (const h of horses) {
          const rate = tbl.get(h[key]) ?? mean
          if (rate > bestRate) {
            bestRate = rate
            best = h
          }
        }
        if (best) bets.push({ win: best.win, payout: best.payout })
      }
      return bets
    }

    // 参考: 市場の1番人気を買った場合
    const favoriteBets: Bet[] = []
    for (const horses of byRace.values()) {
      let best: HorseRow | null = null
      for (const h of horses) if (!best || h.marketProb > best.marketProb) best = h
      if (best) favoriteBets.push({ win: best.win, payout: best.payout })
    }

    console.log(`【${label}】対象${byRace.size}レース / ${rows.length}頭`)
    console.log(`  血統のみ(父馬×馬場適性が最高の馬)\t${fmt(pickBy('sireTrackKey', trackTbl.table, trackTbl.globalMean))}`)
    console.log(`  血統のみ(父馬×距離帯適性が最高の馬)\t${fmt(pickBy('sireDistKey', distTbl.table, distTbl.globalMean))}`)
    console.log(`  参考:市場1番人気\t\t\t${fmt(favoriteBets)}`)
    console.log('')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
