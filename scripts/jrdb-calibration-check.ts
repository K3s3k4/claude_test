// softmax(総合指数)で算出した推定勝率が、実際の的中頻度とどれだけ噛み合っているか(キャリブレーション)を確認する。
// 予測勝率をビンに分け、各ビンの「平均予測勝率」と「実際の勝率」を比較する。
// 実行: npx tsx scripts/jrdb-calibration-check.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities } from '../server/probability'
import { parseKyiBuffer, type KyiRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SED_RECORD_LENGTH = 376
const SOFTMAX_TEMPERATURE = Number(process.argv[2]) || 10

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

// 予測勝率のビン境界(%)
const BIN_EDGES = [0, 2, 5, 8, 12, 17, 25, 100]

function binIndex(pct: number): number {
  for (let i = BIN_EDGES.length - 2; i >= 0; i--) {
    if (pct >= BIN_EDGES[i]) return i
  }
  return 0
}

async function main() {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  console.log(`対象日数: ${pastDates.length}日\n`)

  const bins = BIN_EDGES.slice(0, -1).map(() => ({ count: 0, sumPredicted: 0, wins: 0 }))

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

      horses.forEach((h, i) => {
        const sed = sedRows.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(h.umaban))
        if (!sed) return
        const pct = winProbs[i] * 100
        const idx = binIndex(pct)
        bins[idx].count += 1
        bins[idx].sumPredicted += pct
        if (sed.tanshoPayout > 0) bins[idx].wins += 1
      })
    }
  }

  console.log('予測勝率帯\t頭数\t平均予測勝率\t実際の勝率\t差(実際-予測)')
  bins.forEach((b, i) => {
    const label = `${BIN_EDGES[i]}%〜${BIN_EDGES[i + 1]}%`
    const avgPred = b.count > 0 ? (b.sumPredicted / b.count).toFixed(1) : '-'
    const actual = b.count > 0 ? ((b.wins / b.count) * 100).toFixed(1) : '-'
    const diff = b.count > 0 ? (Number(actual) - Number(avgPred)).toFixed(1) : '-'
    console.log(`${label}\t${b.count}\t${avgPred}%\t${actual}%\t${diff}pt`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
