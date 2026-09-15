// バリューベット(市場オッズとの乖離)で選んだ馬に対し、均等賭け(1点100円)ではなく
// ケリー基準で資金配分した場合、資金成長(複利)がどう変わるかを検証する。
// ケリー基準: f* = (p*O - 1)/(O-1)  (p=自分の推定勝率, O=単勝配当倍率)
// EVがマイナス(p*O<=1)の馬は賭けない。フルケリーは分散が大きいため、
// ハーフケリー・クォーターケリー・上限キャップ付きも並べて比較する。
// 実行: npx tsx scripts/jrdb-kelly-experiment.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities } from '../server/probability'
import { parseKyiBuffer, type KyiRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SED_RECORD_LENGTH = 376
const SOFTMAX_TEMPERATURE = 8
const EDGE_THRESHOLD = Number(process.argv[2]) || 0.08 // バリューベット選定の閾値(検証済みのエッジ+8pt)
const INITIAL_BANKROLL = 100000

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

type Bet = { date: string; odds: number; ourProb: number; win: boolean; payout: number }

async function collectBets(): Promise<Bet[]> {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  const bets: Bet[] = []

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

    for (const horses of grouped.values()) {
      if (horses.length < 3) continue
      const venueCode = String(horses[0].venueCode)
      const raceNumber = Number(horses[0].raceNumber)
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
        if (edge < EDGE_THRESHOLD) continue
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(horses[i].umaban),
        )
        if (!sed) continue
        bets.push({
          date: dateStr8,
          odds,
          ourProb: ourProbs[i],
          win: sed.tanshoPayout > 0,
          payout: sed.tanshoPayout,
        })
      }
    }
  }
  return bets.sort((a, b) => a.date.localeCompare(b.date))
}

// ケリー基準: f* = (p*O - 1)/(O-1)。EVがマイナスなら0(賭けない)。
function kellyFraction(p: number, decimalOdds: number): number {
  if (decimalOdds <= 1) return 0
  const f = (p * decimalOdds - 1) / (decimalOdds - 1)
  return Math.max(0, f)
}

function simulate(bets: Bet[], kellyMultiplier: number, capFraction: number): { finalBankroll: number; bets: number; skipped: number; maxDrawdown: number } {
  let bankroll = INITIAL_BANKROLL
  let peak = bankroll
  let maxDrawdown = 0
  let betsPlaced = 0
  let skipped = 0

  for (const bet of bets) {
    const rawFraction = kellyFraction(bet.ourProb, bet.odds) * kellyMultiplier
    const fraction = Math.min(rawFraction, capFraction)
    if (fraction <= 0) {
      skipped++
      continue
    }
    const stake = bankroll * fraction
    const payoutMultiplier = bet.win ? bet.payout / 100 : 0
    bankroll = bankroll - stake + stake * payoutMultiplier
    betsPlaced++
    peak = Math.max(peak, bankroll)
    maxDrawdown = Math.max(maxDrawdown, (peak - bankroll) / peak)
    if (bankroll < 1) break // 破産
  }
  return { finalBankroll: bankroll, bets: betsPlaced, skipped, maxDrawdown }
}

function simulateFlat(bets: Bet[]): { finalBankroll: number; bets: number } {
  let bankroll = INITIAL_BANKROLL
  const flatStake = 100
  for (const bet of bets) {
    const payoutMultiplier = bet.win ? bet.payout / 100 : 0
    bankroll = bankroll - flatStake + flatStake * payoutMultiplier
  }
  return { finalBankroll: bankroll, bets: bets.length }
}

async function main() {
  console.log(`エッジ閾値+${(EDGE_THRESHOLD * 100).toFixed(0)}pt、初期資金${INITIAL_BANKROLL.toLocaleString()}円で検証\n`)
  const bets = await collectBets()
  console.log(`対象ベット数: ${bets.length}件\n`)

  const flat = simulateFlat(bets)
  console.log('=== 均等賭け(1点100円固定、参考) ===')
  const flatTotalStaked = bets.length * 100
  const flatReturn = ((flat.finalBankroll - INITIAL_BANKROLL + flatTotalStaked) / flatTotalStaked) * 100
  console.log(`総投資額: ${flatTotalStaked.toLocaleString()}円 → 損益: ${Math.round(flat.finalBankroll - INITIAL_BANKROLL).toLocaleString()}円 (回収率換算 ${flatReturn.toFixed(1)}%)\n`)

  console.log('戦略\t最終資金\tベット数\tスキップ数\t最大ドローダウン')
  const configs: { name: string; multiplier: number; cap: number }[] = [
    { name: 'フルケリー(上限なし)', multiplier: 1, cap: 1 },
    { name: 'フルケリー(上限10%)', multiplier: 1, cap: 0.1 },
    { name: 'ハーフケリー(上限10%)', multiplier: 0.5, cap: 0.1 },
    { name: 'ハーフケリー(上限5%)', multiplier: 0.5, cap: 0.05 },
    { name: 'クォーターケリー(上限5%)', multiplier: 0.25, cap: 0.05 },
    { name: 'クォーターケリー(上限3%)', multiplier: 0.25, cap: 0.03 },
  ]
  for (const cfg of configs) {
    const r = simulate(bets, cfg.multiplier, cfg.cap)
    console.log(
      `${cfg.name}\t${Math.round(r.finalBankroll).toLocaleString()}円\t${r.bets}\t${r.skipped}\t${(r.maxDrawdown * 100).toFixed(1)}%`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
