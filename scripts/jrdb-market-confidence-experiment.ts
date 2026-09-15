// ユーザーの提案: 「堅い」ラベルはJRDBの総合指数(JRDBの予測数値)から算出されているため、
// JRDBの予測を信頼しているだけになってしまう。そこで「市場(オッズ)自体が固いと判断しているレース」
// (=客観的事実であり、JRDBの予測ではない)を独自に定義し、そのレース群に限定した場合の成績を検証する。
// 市場確信度(marketGap) = 市場の暗示確率(オッズ由来)における1位・2位の差
// この市場確信度が大きいレースに絞った上で、検証済みのJRDB指数エッジ戦略(単勝)を適用する。
// 実行: npx tsx scripts/jrdb-market-confidence-experiment.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities } from '../server/probability'
import { parseKyiBuffer, type KyiRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SED_RECORD_LENGTH = 376
const SOFTMAX_TEMPERATURE = 8

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
function readNum(buf: Buffer, start1: number, len: number): number {
  const raw = buf.subarray(start1 - 1, start1 - 1 + len).toString('latin1').trim()
  const n = Number(raw)
  return Number.isNaN(n) ? 0 : n
}
type SedRow = { venueCode: string; raceNumber: number; umaban: number; tanshoPayout: number }
function parseSedMinimal(buf: Buffer): SedRow[] {
  const rows: SedRow[] = []
  for (let offset = 0; offset + SED_RECORD_LENGTH <= buf.length; offset += SED_RECORD_LENGTH) {
    const r = buf.subarray(offset, offset + SED_RECORD_LENGTH)
    rows.push({
      venueCode: r.subarray(0, 2).toString('latin1'),
      raceNumber: readNum(r, 7, 2),
      umaban: readNum(r, 9, 2),
      tanshoPayout: readNum(r, 342, 7),
    })
  }
  return rows
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

async function collectRaces(): Promise<
  { raceKey: string; marketGapPt: number; favoriteWin: boolean; favoritePayout: number; ourTopWin: boolean; ourTopPayout: number; ourTopEdgePt: number }[]
> {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  const races: {
    raceKey: string
    marketGapPt: number
    favoriteWin: boolean
    favoritePayout: number
    ourTopWin: boolean
    ourTopPayout: number
    ourTopEdgePt: number
  }[] = []

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
    const sedRows = parseSedMinimal(sedBuf)

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
      if (marketSum <= 0) continue
      const marketProbs = rawMarket.map((v) => v / marketSum)

      const sortedMarket = [...marketProbs].sort((a, b) => b - a)
      const marketGapPt = Math.round((sortedMarket[0] - (sortedMarket[1] ?? 0)) * 1000) / 10

      const favoriteIdx = marketProbs.indexOf(sortedMarket[0])
      const favoriteHorse = horses[favoriteIdx]
      const favoriteSed = sedRows.find(
        (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(favoriteHorse.umaban),
      )
      if (!favoriteSed) continue

      const scores = horses.map((h) => num(h.overallIndex))
      const ourProbs = softmaxProbabilities(scores, SOFTMAX_TEMPERATURE)
      const ourTopIdx = ourProbs.indexOf(Math.max(...ourProbs))
      const ourTopHorse = horses[ourTopIdx]
      const ourTopSed = sedRows.find(
        (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(ourTopHorse.umaban),
      )
      if (!ourTopSed) continue

      const ourTopEdgePt = Math.round((ourProbs[ourTopIdx] - marketProbs[ourTopIdx]) * 1000) / 10

      races.push({
        raceKey: `${dateStr8}-${key}`,
        marketGapPt,
        favoriteWin: favoriteSed.tanshoPayout > 0,
        favoritePayout: favoriteSed.tanshoPayout,
        ourTopWin: ourTopSed.tanshoPayout > 0,
        ourTopPayout: ourTopSed.tanshoPayout,
        ourTopEdgePt,
      })
    }
  }
  return races
}

function fmt(rows: { win: boolean; payout: number }[]) {
  const attempts = rows.length
  const hits = rows.filter((r) => r.win).length
  const stake = attempts * 100
  const payout = rows.reduce((s, r) => s + r.payout, 0)
  const hitRate = attempts > 0 ? Math.round((hits / attempts) * 1000) / 10 : 0
  const returnRate = stake > 0 ? Math.round((payout / stake) * 1000) / 10 : 0
  return `試行${attempts}\t的中${hits}\t的中率${hitRate}%\t回収率${returnRate}%`
}

async function main() {
  console.log('市場自身の確信度(オッズ由来、JRDB指数は使わない)でレースを絞り込んだ場合の成績を検証\n')
  const races = await collectRaces()
  console.log(`対象レース数: ${races.length}件\n`)

  const raceKeys = [...new Set(races.map((r) => r.raceKey))].sort()
  const FOLDS = 5
  const foldSize = Math.floor(raceKeys.length / FOLDS)

  const gapThresholds = [0, 10, 20, 30, 40, 50]
  const edgeThresholds = [0, 4, 8, 12]

  console.log('=== ウォークフォワード検証(5分割)。市場確信度(gap)閾値 × 自分のトップ予想馬のエッジ閾値 ===\n')
  console.log('(自分のトップ予想馬 = JRDB総合指数ベースの本命。市場確信度は市場オッズのみから算出)\n')

  // 全fold合算用
  const aggregate = new Map<string, { win: boolean; payout: number }[]>()
  const favoriteAggregate = new Map<number, { win: boolean; payout: number }[]>()
  for (const gt of gapThresholds) {
    favoriteAggregate.set(gt, [])
    for (const et of edgeThresholds) aggregate.set(`${gt}|${et}`, [])
  }

  for (let fold = 1; fold < FOLDS; fold++) {
    const testStart = foldSize * fold
    const testEnd = fold === FOLDS - 1 ? raceKeys.length : foldSize * (fold + 1)
    const foldTestKeys = new Set(raceKeys.slice(testStart, testEnd))
    const foldRaces = races.filter((r) => foldTestKeys.has(r.raceKey))

    console.log(`--- fold${fold}(${foldRaces.length}件) ---`)
    for (const gt of gapThresholds) {
      const inGap = foldRaces.filter((r) => r.marketGapPt >= gt)
      const favRows = inGap.map((r) => ({ win: r.favoriteWin, payout: r.favoritePayout }))
      favoriteAggregate.get(gt)!.push(...favRows)
      console.log(`  市場gap>=${gt}pt 市場favorite買い(参考)\t${fmt(favRows)}`)
      for (const et of edgeThresholds) {
        const rows = inGap.filter((r) => r.ourTopEdgePt >= et).map((r) => ({ win: r.ourTopWin, payout: r.ourTopPayout }))
        aggregate.get(`${gt}|${et}`)!.push(...rows)
        console.log(`  市場gap>=${gt}pt かつ 自分の本命エッジ>=${et}pt\t${fmt(rows)}`)
      }
    }
    console.log('')
  }

  console.log('=== 全fold合算(アウトオブサンプル全体) ===')
  for (const gt of gapThresholds) {
    console.log(`市場gap>=${gt}pt 市場favorite買い(参考)\t${fmt(favoriteAggregate.get(gt)!)}`)
    for (const et of edgeThresholds) {
      console.log(`市場gap>=${gt}pt かつ 自分の本命エッジ>=${et}pt\t${fmt(aggregate.get(`${gt}|${et}`)!)}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
