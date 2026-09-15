// 枠番(スタート位置)・競馬場ごとに、市場(オッズ)が織り込んでいる暗示勝率と実際の勝率を比較し、
// 「みんなと同じ買い方」で構造的に有利/不利な枠・場があるかを検証する。
// 実行: npx tsx scripts/jrdb-waku-venue-bias.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { VENUE_NAMES } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const RECORD_LENGTH = 1024
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

type KyiHorse = { venueCode: string; raceNumber: number; umaban: number; waku: number; baseOdds: number }
function parseKyiForBias(buf: Buffer): KyiHorse[] {
  const rows: KyiHorse[] = []
  for (let offset = 0; offset + RECORD_LENGTH <= buf.length; offset += RECORD_LENGTH) {
    const r = buf.subarray(offset, offset + RECORD_LENGTH)
    rows.push({
      venueCode: r.subarray(0, 2).toString('latin1'),
      raceNumber: readNum(r, 7, 2),
      umaban: readNum(r, 9, 2),
      waku: readNum(r, 324, 1), // 枠番(第4版で追加、相対位置324・1桁)
      baseOdds: readNum(r, 96, 5),
    })
  }
  return rows
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

async function main() {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  console.log(`対象日数: ${pastDates.length}日\n`)

  // 枠番(1-8)ごと: 実際に賭けた場合の単勝回収率(=市場オッズ通りに賭けた場合の構造的な有利不利)
  const wakuStats = new Map<number, { attempts: number; hits: number; stake: number; payout: number }>()
  const venueStats = new Map<string, { attempts: number; hits: number; stake: number; payout: number }>()

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
    const kyiRows = parseKyiForBias(kyiBuf)
    const sedRows = parseSedMinimal(sedBuf)

    for (const h of kyiRows) {
      if (h.waku < 1 || h.waku > 8 || h.baseOdds <= 0) continue
      const sed = sedRows.find((r) => r.venueCode === h.venueCode && r.raceNumber === h.raceNumber && r.umaban === h.umaban)
      if (!sed) continue

      const w = wakuStats.get(h.waku) ?? { attempts: 0, hits: 0, stake: 0, payout: 0 }
      w.attempts += 1
      w.stake += 100
      w.payout += sed.tanshoPayout
      if (sed.tanshoPayout > 0) w.hits += 1
      wakuStats.set(h.waku, w)

      const v = venueStats.get(h.venueCode) ?? { attempts: 0, hits: 0, stake: 0, payout: 0 }
      v.attempts += 1
      v.stake += 100
      v.payout += sed.tanshoPayout
      if (sed.tanshoPayout > 0) v.hits += 1
      venueStats.set(h.venueCode, v)
    }
  }

  console.log('【枠番別】市場オッズ通りに単勝を全頭買った場合の回収率(市場の織り込みが正しければ理論上どの枠も同程度になるはず)')
  console.log('枠番\t試行数\t的中率\t回収率')
  for (let w = 1; w <= 8; w++) {
    const s = wakuStats.get(w)
    if (!s) continue
    const hitRate = s.attempts > 0 ? Math.round((s.hits / s.attempts) * 1000) / 10 : 0
    const returnRate = s.stake > 0 ? Math.round((s.payout / s.stake) * 1000) / 10 : 0
    console.log(`${w}枠\t${s.attempts}\t${hitRate}%\t${returnRate}%`)
  }

  console.log('\n【競馬場別】同様の全頭単勝回収率')
  console.log('競馬場\t試行数\t的中率\t回収率')
  for (const [code, s] of [...venueStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hitRate = s.attempts > 0 ? Math.round((s.hits / s.attempts) * 1000) / 10 : 0
    const returnRate = s.stake > 0 ? Math.round((s.payout / s.stake) * 1000) / 10 : 0
    console.log(`${VENUE_NAMES[code] ?? code}\t${s.attempts}\t${hitRate}%\t${returnRate}%`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
