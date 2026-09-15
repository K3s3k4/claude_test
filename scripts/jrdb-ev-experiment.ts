// 「推定勝率×基準オッズ(期待値EV)が閾値を超える馬だけ単勝で賭ける」戦略が、
// 常に本命(argmax)を賭ける現行方式より回収率を改善するか検証する実験スクリプト。
// 実行: npx tsx scripts/jrdb-ev-experiment.ts
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
  console.log(`対象日数: ${pastDates.length}日\n`)

  // EV閾値ごとの集計 + 比較用に「常に本命1点」の集計も行う
  const evThresholds = [0.8, 0.9, 1.0, 1.1, 1.2, 1.5]
  const evResults: Record<number, { attempts: number; hits: number; stake: number; payout: number }> = {}
  for (const t of evThresholds) evResults[t] = { attempts: 0, hits: 0, stake: 0, payout: 0 }
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
      const winProbs = softmaxProbabilities(scores, SOFTMAX_TEMPERATURE)

      // 基準: 常にargmax(本命)1点
      const topIdx = winProbs.indexOf(Math.max(...winProbs))
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

      // EV戦略: EV > 閾値の馬全部に単勝を賭ける(0頭〜複数頭ありうる)
      for (let i = 0; i < horses.length; i++) {
        const odds = num(horses[i].baseOdds)
        if (odds <= 0) continue
        const ev = winProbs[i] * odds
        const sed = sedRows.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(horses[i].umaban))
        if (!sed) continue
        for (const t of evThresholds) {
          if (ev < t) continue
          const res = evResults[t]
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
  for (const t of evThresholds) {
    const r = evResults[t]
    const hitRate = r.attempts > 0 ? Math.round((r.hits / r.attempts) * 1000) / 10 : 0
    const returnRate = r.stake > 0 ? Math.round((r.payout / r.stake) * 1000) / 10 : 0
    console.log(`EV>${t}の馬に賭ける\t${r.attempts}\t${r.hits}\t${hitRate}%\t${returnRate}%`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
