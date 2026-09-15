// JRDBアーカイブ全体を使って、softmaxの温度パラメータを何パターンか試し、
// 通算回収率への影響を比較するための使い捨て実験スクリプト。
// 実行: npx tsx scripts/jrdb-backtest-experiment.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities, placeProbability } from '../server/probability'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const RECORD_LENGTH = 1024
const SED_RECORD_LENGTH = 376
const HJC_RECORD_LENGTH = 444

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

function readInt(buf: Buffer, start1: number, len: number): number | null {
  const raw = buf.subarray(start1 - 1, start1 - 1 + len).toString('latin1').trim()
  if (raw.length === 0) return null
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

type KyiHorse = { venueCode: string; raceNumber: number; umaban: number; overallIndex: number }

function parseKyiMinimal(buf: Buffer): KyiHorse[] {
  const rows: KyiHorse[] = []
  for (let offset = 0; offset + RECORD_LENGTH <= buf.length; offset += RECORD_LENGTH) {
    const r = buf.subarray(offset, offset + RECORD_LENGTH)
    const venueCode = r.subarray(0, 2).toString('latin1')
    const raceNumber = readInt(r, 7, 2) ?? 0
    const umaban = readInt(r, 9, 2) ?? 0
    const overallIndex = readInt(r, 85, 5) ?? 0 // ZZ9.9として格納されているが桁位置のみ使うので生の数値化で十分(比較用途)
    rows.push({ venueCode, raceNumber, umaban, overallIndex })
  }
  return rows
}

type SedRow = { venueCode: string; raceNumber: number; umaban: number; tanshoPayout: number; fukushoPayout: number }

function parseSedMinimal(buf: Buffer): SedRow[] {
  const rows: SedRow[] = []
  for (let offset = 0; offset + SED_RECORD_LENGTH <= buf.length; offset += SED_RECORD_LENGTH) {
    const r = buf.subarray(offset, offset + SED_RECORD_LENGTH)
    const venueCode = r.subarray(0, 2).toString('latin1')
    const raceNumber = readInt(r, 7, 2) ?? 0
    const umaban = readInt(r, 9, 2) ?? 0
    const tanshoPayout = readInt(r, 342, 7) ?? 0
    const fukushoPayout = readInt(r, 349, 7) ?? 0
    rows.push({ venueCode, raceNumber, umaban, tanshoPayout, fukushoPayout })
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

// 単勝・複勝のみで、指定した温度・予算配分方式で通算回収率を計算する(高速な実験用の簡易版)。
async function backtestTansho(temperature: number, dates: Date[]): Promise<{ attempts: number; stake: number; payout: number }> {
  let attempts = 0
  let stake = 0
  let payout = 0

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
    const kyiRows = parseKyiMinimal(kyiBuf)
    const sedRows = parseSedMinimal(sedBuf)

    const grouped = new Map<string, KyiHorse[]>()
    for (const r of kyiRows) {
      const key = `${r.venueCode}-${r.raceNumber}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(r)
    }

    for (const horses of grouped.values()) {
      if (horses.length < 3) continue
      const scores = horses.map((h) => h.overallIndex) // readIntはNumber()経由でZZ9.9形式の小数点をそのまま解釈する
      const winProbs = softmaxProbabilities(scores, temperature)
      const topIdx = winProbs.indexOf(Math.max(...winProbs))
      const topHorse = horses[topIdx]

      const sedRow = sedRows.find((r) => r.venueCode === topHorse.venueCode && r.raceNumber === topHorse.raceNumber && r.umaban === topHorse.umaban)
      if (!sedRow) continue // 結果未確定

      attempts += 1
      stake += 100
      payout += sedRow.tanshoPayout
    }
  }

  return { attempts, stake, payout }
}

async function main() {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  console.log(`対象日数: ${pastDates.length}日`)

  const temperatures = [3, 5, 8, 10, 15, 20, 30, 50]
  console.log('\n温度パラメータごとの単勝回収率(本命1点のみ):')
  console.log('温度\t試行数\t購入額\t払戻額\t回収率')
  for (const t of temperatures) {
    const { attempts, stake, payout } = await backtestTansho(t, pastDates)
    const returnRate = stake > 0 ? Math.round((payout / stake) * 1000) / 10 : 0
    console.log(`${t}\t${attempts}\t${stake}\t${payout}\t${returnRate}%`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
