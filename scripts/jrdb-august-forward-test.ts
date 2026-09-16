// 新機能: 1つの切り口(市場確信度gap)だけに絞った「分析ベース」を作り、直近の8月データに実際にぶつけて
// 予測と結果を1レースずつ見比べる。少数サンプルでの見え方(=ノイズかどうか)を実感するための機能。
// 市場確信度gap = 市場暗示確率(オッズ由来)の1位-2位差。JRDBの予測数値ではなく市場オッズという客観的事実。
// gap>=20pt(大規模検証済み・信頼できる帯)とgap>=30pt(小サンプルで好成績だが未確定な帯)の両方を対象にする。
// 実行: npx tsx scripts/jrdb-august-forward-test.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseKyiBuffer, VENUE_NAMES, type KyiRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SED_RECORD_LENGTH = 376

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
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

async function listAugustDates(): Promise<Date[]> {
  const dir = path.join(DATA_DIR, 'Kyi')
  const files = await fs.readdir(dir)
  const dates: Date[] = []
  for (const f of files) {
    const m = f.match(/^KYI(\d{2})(\d{2})(\d{2})\.txt$/)
    if (!m) continue
    if (m[1] !== '26' || m[2] !== '08') continue // 直近の2026年8月のみ(過去の8月と混同しないよう年も指定)
    dates.push(new Date(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  }
  return dates.sort((a, b) => a.getTime() - b.getTime())
}

type RaceResult = {
  date: string
  venueName: string
  raceNumber: number
  marketGapPt: number
  pickUmaban: number
  pickName: string
  pickOdds: number
  win: boolean
  payout: number
}

async function main() {
  console.log('=== 分析ベース: 市場確信度gap(オッズ由来、JRDBの予測数値は使わない)を8月データに適用 ===\n')
  const dates = await listAugustDates()
  console.log(`対象日数: ${dates.length}日(2026年8月)\n`)

  const results: RaceResult[] = []

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
    const kyiRows = parseKyiBuffer(kyiBuf)
    const sedRows = parseSedMinimal(sedBuf)

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
      const venueName = VENUE_NAMES[venueCode] ?? venueCode

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
      const sed = sedRows.find(
        (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(favoriteHorse.umaban),
      )
      if (!sed) continue

      results.push({
        date: `${dateStr8.slice(0, 2)}/${dateStr8.slice(2, 4)}/${dateStr8.slice(4, 6)}`,
        venueName,
        raceNumber,
        marketGapPt,
        pickUmaban: num(favoriteHorse.umaban),
        pickName: str(favoriteHorse.horseName),
        pickOdds: num(favoriteHorse.baseOdds),
        win: sed.tanshoPayout > 0,
        payout: sed.tanshoPayout,
      })
    }
  }

  for (const threshold of [20, 30]) {
    const filtered = results.filter((r) => r.marketGapPt >= threshold).sort((a, b) => b.marketGapPt - a.marketGapPt)
    console.log(`\n=== 市場gap>=${threshold}pt(8月のみ) — 該当${filtered.length}レース ===`)
    console.log('日付\t競馬場\tR\tgap\t買い目\tオッズ\t結果\t払戻')
    for (const r of filtered) {
      console.log(
        `${r.date}\t${r.venueName}\t${r.raceNumber}R\t${r.marketGapPt}pt\t${r.pickUmaban} ${r.pickName}\t${r.pickOdds.toFixed(1)}倍\t${r.win ? '的中' : '不的中'}\t${r.payout}円`,
      )
    }
    const attempts = filtered.length
    const hits = filtered.filter((r) => r.win).length
    const stake = attempts * 100
    const payout = filtered.reduce((s, r) => s + r.payout, 0)
    const hitRate = attempts > 0 ? Math.round((hits / attempts) * 1000) / 10 : 0
    const returnRate = stake > 0 ? Math.round((payout / stake) * 1000) / 10 : 0
    console.log(`集計: 試行${attempts} 的中${hits} 的中率${hitRate}% 回収率${returnRate}%`)
  }

  console.log('\n=== 参考: 8月全レース(gapによる絞り込みなし、市場favorite買い) ===')
  const allHits = results.filter((r) => r.win).length
  const allStake = results.length * 100
  const allPayout = results.reduce((s, r) => s + r.payout, 0)
  console.log(
    `試行${results.length} 的中${allHits} 的中率${results.length > 0 ? Math.round((allHits / results.length) * 1000) / 10 : 0}% 回収率${allStake > 0 ? Math.round((allPayout / allStake) * 1000) / 10 : 0}%`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
