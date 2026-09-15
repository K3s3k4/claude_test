// 自分の推定勝率が「市場(オッズから逆算した確率)」をどれだけ上回るか(エッジ)で選別し、
// 市場より自分の予想が高い馬だけに賭ける「バリューベッティング」戦略を検証する。
// 実行: npx tsx scripts/jrdb-value-bet-experiment.ts [temperature]
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities } from '../server/probability'
import { parseKyiBuffer, type KyiRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SED_RECORD_LENGTH = 376
const SOFTMAX_TEMPERATURE = Number(process.argv[2]) || 8

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

async function main() {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  console.log(`対象日数: ${pastDates.length}日 (softmax温度=${SOFTMAX_TEMPERATURE})\n`)

  const edgeThresholds = [0, 0.02, 0.04, 0.06, 0.08, 0.1]
  const results: Record<number, { attempts: number; hits: number; stake: number; payout: number }> = {}
  for (const t of edgeThresholds) results[t] = { attempts: 0, hits: 0, stake: 0, payout: 0 }
  const baseline = { attempts: 0, hits: 0, stake: 0, payout: 0 }

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

      // 市場の暗示確率(オッズの逆数)。オーバーラウンド(合計が100%を超える控除分)を正規化して除く。
      const rawMarket = horses.map((h) => {
        const odds = num(h.baseOdds)
        return odds > 0 ? 1 / odds : 0
      })
      const marketSum = rawMarket.reduce((s, v) => s + v, 0)
      const marketProbs = marketSum > 0 ? rawMarket.map((v) => v / marketSum) : rawMarket

      // 基準: 常にargmax(本命)1点
      const topIdx = ourProbs.indexOf(Math.max(...ourProbs))
      const topHorse = horses[topIdx]
      const topSed = sedRows.find(
        (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(topHorse.umaban),
      )
      if (topSed) {
        baseline.attempts += 1
        baseline.stake += 100
        baseline.payout += topSed.tanshoPayout
        if (topSed.tanshoPayout > 0) baseline.hits += 1
      }

      // バリューベット: 自分の予想確率が市場確率をedge以上上回る馬全部に賭ける
      for (let i = 0; i < horses.length; i++) {
        if (num(horses[i].baseOdds) <= 0) continue
        const edge = ourProbs[i] - marketProbs[i]
        const sed = sedRows.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(horses[i].umaban))
        if (!sed) continue
        for (const t of edgeThresholds) {
          if (edge < t) continue
          const res = results[t]
          res.attempts += 1
          res.stake += 100
          res.payout += sed.tanshoPayout
          if (sed.tanshoPayout > 0) res.hits += 1
        }
      }
    }
  }

  console.log('戦略\t試行数\t的中数\t的中率\t回収率')
  const bHit = baseline.attempts > 0 ? Math.round((baseline.hits / baseline.attempts) * 1000) / 10 : 0
  const bRet = baseline.stake > 0 ? Math.round((baseline.payout / baseline.stake) * 1000) / 10 : 0
  console.log(`常に本命1点(現行)\t${baseline.attempts}\t${baseline.hits}\t${bHit}%\t${bRet}%`)
  for (const t of edgeThresholds) {
    const r = results[t]
    const hitRate = r.attempts > 0 ? Math.round((r.hits / r.attempts) * 1000) / 10 : 0
    const returnRate = r.stake > 0 ? Math.round((r.payout / r.stake) * 1000) / 10 : 0
    console.log(`自分の予想が市場+${(t * 100).toFixed(0)}pt以上\t${r.attempts}\t${r.hits}\t${hitRate}%\t${returnRate}%`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
