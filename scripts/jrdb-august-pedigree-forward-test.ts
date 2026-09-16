// 新機能: 血統(父馬×馬場適性)という1つの切り口だけに絞った「分析ベース」を作り、
// 直近の2026年8月データに実際にぶつけて予測と結果を1レースずつ見比べる。
// 血統勝率テーブルは2026年7月末までのデータのみから算出(8月分は一切使わない・リーク防止)。
// 単勝バリューベット(検証済みのエッジ+8pt以上)の中から、父馬×馬場適性が平均×1.2倍以上の馬だけを選ぶ。
// 実行: npx tsx scripts/jrdb-august-pedigree-forward-test.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities, empiricalBayesShrink } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseUkcBuffer, VENUE_NAMES, type KyiRow, type SedRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SOFTMAX_TEMPERATURE = 8
const EDGE_THRESHOLD = 0.08
const SIRE_TRACK_MULT = 1.2 // 検証済みの最良閾値

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
async function listAllDates(): Promise<Date[]> {
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

type EdgeBet = {
  date: string
  venueName: string
  raceNumber: number
  umaban: number
  horseName: string
  odds: number
  edgePt: number
  sireTrackKey: string
  sireTrackRate: number | null
  win: boolean
  payout: number
}

async function collectEdgeBets(dates: Date[], sireTable?: Map<string, number>, sireGlobalMean?: number): Promise<EdgeBet[]> {
  const bets: EdgeBet[] = []

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
    const sedRows = parseSedBuffer(sedBuf)

    let ukcByKetto: Map<string, UkcRow> | null = null
    try {
      const ukcBuf = await fs.readFile(path.join(DATA_DIR, 'Ukc', `UKC${dateStr8}.txt`))
      const ukcRows = parseUkcBuffer(ukcBuf)
      ukcByKetto = new Map(ukcRows.map((r) => [str(r.kettoNumber), r]))
    } catch {
      // UKC未取得日は血統キーを空のままにする
    }

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
      const scores = horses.map((h) => num(h.overallIndex))
      const ourProbs = softmaxProbabilities(scores, SOFTMAX_TEMPERATURE)

      const rawMarket = horses.map((h) => {
        const odds = num(h.baseOdds)
        return odds > 0 ? 1 / odds : 0
      })
      const marketSum = rawMarket.reduce((s, v) => s + v, 0)
      const marketProbs = marketSum > 0 ? rawMarket.map((v) => v / marketSum) : rawMarket

      for (let i = 0; i < horses.length; i++) {
        const odds = num(horses[i].baseOdds)
        if (odds <= 0) continue
        const edge = ourProbs[i] - marketProbs[i]
        const edgePt = Math.round(edge * 1000) / 10
        if (edge < EDGE_THRESHOLD) continue
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(horses[i].umaban),
        )
        if (!sed) continue
        const ukc = ukcByKetto?.get(str(horses[i].kettoNumber))
        const sireName = ukc ? str(ukc.sireName) : ''
        const trackCode = num(sed.trackCode)
        const sireTrackKey = sireName && trackCode ? `${sireName}|${trackCode}` : ''
        const sireTrackRate = sireTable && sireTrackKey ? (sireTable.get(sireTrackKey) ?? sireGlobalMean ?? null) : null

        bets.push({
          date: `${dateStr8.slice(0, 2)}/${dateStr8.slice(2, 4)}/${dateStr8.slice(4, 6)}`,
          venueName,
          raceNumber,
          umaban: num(horses[i].umaban),
          horseName: str(horses[i].horseName),
          odds,
          edgePt,
          sireTrackKey,
          sireTrackRate,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
        })
      }
    }
  }
  return bets
}

function buildSireTrackTable(bets: EdgeBet[]): { table: Map<string, number>; globalMean: number } {
  const withKey = bets.filter((b) => b.sireTrackKey)
  const globalMean = withKey.length > 0 ? withKey.filter((b) => b.win).length / withKey.length : 0
  const stats = new Map<string, { wins: number; count: number }>()
  for (const b of withKey) {
    const cur = stats.get(b.sireTrackKey) ?? { wins: 0, count: 0 }
    cur.count += 1
    if (b.win) cur.wins += 1
    stats.set(b.sireTrackKey, cur)
  }
  const table = new Map<string, number>()
  for (const [k, { wins, count }] of stats) {
    table.set(k, empiricalBayesShrink((wins / count) * 100, count, globalMean * 100, 20) / 100)
  }
  return { table, globalMean }
}

function fmt(bets: EdgeBet[]) {
  const attempts = bets.length
  const hits = bets.filter((b) => b.win).length
  const stake = attempts * 100
  const payout = bets.reduce((s, b) => s + b.payout, 0)
  const hitRate = attempts > 0 ? Math.round((hits / attempts) * 1000) / 10 : 0
  const returnRate = stake > 0 ? Math.round((payout / stake) * 1000) / 10 : 0
  return `試行${attempts}\t的中${hits}\t的中率${hitRate}%\t回収率${returnRate}%`
}

async function main() {
  console.log('=== 分析ベース: 単勝バリューベット(エッジ+8pt以上)×父馬×馬場適性(×1.2倍以上) ===')
  console.log('血統勝率テーブルは2026年7月末までのデータのみから算出(8月分は使わずリーク防止)\n')

  const allDates = await listAllDates()
  const trainDates = allDates.filter((d) => d < new Date(2026, 7, 1)) // 2026-08-01より前(月は0始まりなので7=8月)
  const augustDates = allDates.filter((d) => d >= new Date(2026, 7, 1) && d < new Date(2026, 8, 1))

  console.log(`学習期間: 〜2026年7月末(${trainDates.length}日) / テスト期間: 2026年8月(${augustDates.length}日)\n`)

  const trainBets = await collectEdgeBets(trainDates)
  const { table: sireTable, globalMean } = buildSireTrackTable(trainBets)
  console.log(`血統(父馬×馬場)テーブル: ${sireTable.size}種類の組み合わせ、全体平均勝率${(globalMean * 100).toFixed(1)}%\n`)

  const augustBets = await collectEdgeBets(augustDates, sireTable, globalMean)

  console.log(`=== 8月の単勝バリューベット対象(エッジ+8pt以上、絞り込みなし) — ${augustBets.length}件 ===`)
  console.log(fmt(augustBets))

  const filtered = augustBets
    .filter((b) => b.sireTrackKey && (b.sireTrackRate ?? 0) >= globalMean * SIRE_TRACK_MULT)
    .sort((a, b) => (b.sireTrackRate ?? 0) - (a.sireTrackRate ?? 0))

  console.log(`\n=== 8月:父馬×馬場適性フィルタ適用後(勝率>=平均×${SIRE_TRACK_MULT}) — ${filtered.length}件 ===`)
  console.log('日付\t競馬場\tR\t馬\tエッジ\t父系馬場適性\tオッズ\t結果\t払戻')
  for (const b of filtered) {
    console.log(
      `${b.date}\t${b.venueName}\t${b.raceNumber}R\t${b.umaban} ${b.horseName}\t+${b.edgePt}pt\t${((b.sireTrackRate ?? 0) * 100).toFixed(1)}%\t${b.odds.toFixed(1)}倍\t${b.win ? '的中' : '不的中'}\t${b.payout}円`,
    )
  }
  console.log(fmt(filtered))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
