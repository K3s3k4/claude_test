// JRDBの複数指数(IDM・騎手指数・情報指数・調教指数・厩舎指数)を組み合わせた
// 合成スコア候補を何パターンか試し、単勝の本命的中率・回収率を比較する実験スクリプト。
// 実行: npx tsx scripts/jrdb-score-experiment.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseKyiBuffer, type KyiRow } from '../server/jrdbParser'

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

type ScoreFn = (h: KyiRow) => number
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

const CANDIDATES: Record<string, ScoreFn> = {
  '総合指数のみ(現行)': (h) => num(h.overallIndex),
  IDMのみ: (h) => num(h.idm),
  '5指数均等平均': (h) => (num(h.idm) + num(h.jockeyIndex) + num(h.infoIndex) + num(h.trainingIndex) + num(h.stableIndex)) / 5,
  'IDM重視(IDM50%+他50%)': (h) =>
    num(h.idm) * 0.5 + num(h.jockeyIndex) * 0.15 + num(h.infoIndex) * 0.15 + num(h.trainingIndex) * 0.1 + num(h.stableIndex) * 0.1,
  'IDM+騎手指数のみ': (h) => num(h.idm) * 0.7 + num(h.jockeyIndex) * 0.3,
  '総合指数+基準人気(逆数)': (h) => num(h.overallIndex) + (num(h.basePopularity) > 0 ? 30 / num(h.basePopularity) : 0),
}

async function main() {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  console.log(`対象日数: ${pastDates.length}日\n`)

  const results: Record<string, { attempts: number; hits: number; stake: number; payout: number }> = {}
  for (const name of Object.keys(CANDIDATES)) results[name] = { attempts: 0, hits: 0, stake: 0, payout: 0 }

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

      for (const [name, scoreFn] of Object.entries(CANDIDATES)) {
        let top = horses[0]
        let topScore = scoreFn(top)
        for (const h of horses.slice(1)) {
          const s = scoreFn(h)
          if (s > topScore) {
            top = h
            topScore = s
          }
        }
        const umaban = Number(top.umaban)
        const sedRow = sedRows.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === umaban)
        if (!sedRow) continue

        const res = results[name]
        res.attempts += 1
        res.stake += 100
        res.payout += sedRow.tanshoPayout
        if (sedRow.tanshoPayout > 0) res.hits += 1
      }
    }
  }

  console.log('候補\t試行数\t的中数\t的中率\t回収率')
  for (const [name, r] of Object.entries(results)) {
    const hitRate = r.attempts > 0 ? Math.round((r.hits / r.attempts) * 1000) / 10 : 0
    const returnRate = r.stake > 0 ? Math.round((r.payout / r.stake) * 1000) / 10 : 0
    console.log(`${name}\t${r.attempts}\t${r.hits}\t${hitRate}%\t${returnRate}%`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
