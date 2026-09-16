// ユーザー要望:「血統分析において、三世代前までしっかり見て」
// JRDBのUKCには個体名ベースの祖父母データは無いが、父系統コード・母父系統コードという
// JRDBが多世代の血統系譜を分類したフィールドが既にダウンロード済みデータに含まれている
// (系統は通常、祖先を何世代も遡った「一族」単位の分類であり、父馬個体名より広い血統情報を持つ)。
// これまで一度も使っていなかったこのフィールドを、父馬×馬場適性と同じ方法論で検証する。
// 実行: npx tsx scripts/jrdb-keito-aptitude-experiment.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities, empiricalBayesShrink } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseUkcBuffer, type KyiRow, type SedRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SOFTMAX_TEMPERATURE = 8
const EDGE_THRESHOLD = 0.08

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
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
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

type EdgeBet = {
  raceKey: string
  win: boolean
  payout: number
  sireKeitoTrackKey: string // 父系統コード×芝ダート
  damSireKeitoTrackKey: string // 母父系統コード×芝ダート
  sireKeitoKey: string // 父系統コードのみ(馬場を問わない)
}

async function collectEdgeBets(): Promise<EdgeBet[]> {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  const bets: EdgeBet[] = []

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
    const sedRows = parseSedBuffer(sedBuf)

    let ukcByKetto: Map<string, UkcRow> | null = null
    try {
      const ukcBuf = await fs.readFile(path.join(DATA_DIR, 'Ukc', `UKC${dateStr8}.txt`))
      const ukcRows = parseUkcBuffer(ukcBuf)
      ukcByKetto = new Map(ukcRows.map((r) => [str(r.kettoNumber), r]))
    } catch {
      // UKC未取得日は系統キーを空のままにする
    }

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
      const scores = horses.map((h) => num(h.overallIndex))
      const ourProbs = softmaxProbabilities(scores, SOFTMAX_TEMPERATURE)

      const rawMarket = horses.map((h) => {
        const odds = num(h.baseOdds)
        return odds > 0 ? 1 / odds : 0
      })
      const marketSum = rawMarket.reduce((s, v) => s + v, 0)
      const marketProbs = marketSum > 0 ? rawMarket.map((v) => v / marketSum) : rawMarket

      for (let i = 0; i < horses.length; i++) {
        if (num(horses[i].baseOdds) <= 0) continue
        const edge = ourProbs[i] - marketProbs[i]
        if (edge < EDGE_THRESHOLD) continue
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(horses[i].umaban),
        )
        if (!sed) continue
        const ukc = ukcByKetto?.get(str(horses[i].kettoNumber))
        const sireKeito = ukc ? String(ukc.sireKeitoCode ?? '') : ''
        const damSireKeito = ukc ? String(ukc.damSireKeitoCode ?? '') : ''
        const trackCode = num(sed.trackCode)
        bets.push({
          raceKey: `${dateStr8}-${key}`,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
          sireKeitoTrackKey: sireKeito && trackCode ? `${sireKeito}|${trackCode}` : '',
          damSireKeitoTrackKey: damSireKeito && trackCode ? `${damSireKeito}|${trackCode}` : '',
          sireKeitoKey: sireKeito || '',
        })
      }
    }
  }
  return bets
}

function buildWinRateTable(bets: EdgeBet[], key: keyof EdgeBet): { table: Map<string, number>; globalMean: number } {
  const withKey = bets.filter((b) => b[key])
  const globalMean = withKey.length > 0 ? withKey.filter((b) => b.win).length / withKey.length : 0
  const stats = new Map<string, { wins: number; count: number }>()
  for (const b of withKey) {
    const k = String(b[key])
    const cur = stats.get(k) ?? { wins: 0, count: 0 }
    cur.count += 1
    if (b.win) cur.wins += 1
    stats.set(k, cur)
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
  console.log('単勝バリューベット(エッジ+8pt以上)に系統コード(父系統×馬場、母父系統×馬場)フィルタを重ねた場合の効果を検証\n')
  const allBets = await collectEdgeBets()
  console.log(`エッジ条件を満たすベット総数: ${allBets.length}件\n`)

  const raceKeys = [...new Set(allBets.map((b) => b.raceKey))].sort()

  console.log('=== ウォークフォワード検証(5分割、各foldは直前までの全データで学習) ===\n')
  const FOLDS = 5
  const foldSize = Math.floor(raceKeys.length / FOLDS)

  const filterConfigs: { name: string; key: keyof EdgeBet; mult: number }[] = [
    { name: '父系統コード単体>=平均×1.1', key: 'sireKeitoKey', mult: 1.1 },
    { name: '父系統コード単体>=平均×1.2', key: 'sireKeitoKey', mult: 1.2 },
    { name: '父系統×馬場>=平均×1.1', key: 'sireKeitoTrackKey', mult: 1.1 },
    { name: '父系統×馬場>=平均×1.2', key: 'sireKeitoTrackKey', mult: 1.2 },
    { name: '母父系統×馬場>=平均×1.1', key: 'damSireKeitoTrackKey', mult: 1.1 },
    { name: '母父系統×馬場>=平均×1.2', key: 'damSireKeitoTrackKey', mult: 1.2 },
  ]

  const aggregate = new Map<string, EdgeBet[]>()
  const aggregateBaseline: EdgeBet[] = []
  for (const cfg of filterConfigs) aggregate.set(cfg.name, [])

  for (let fold = 1; fold < FOLDS; fold++) {
    const trainEnd = foldSize * fold
    const testStart = trainEnd
    const testEnd = fold === FOLDS - 1 ? raceKeys.length : foldSize * (fold + 1)
    const foldTrainKeys = new Set(raceKeys.slice(0, trainEnd))
    const foldTestKeys = new Set(raceKeys.slice(testStart, testEnd))
    const foldTrainBets = allBets.filter((b) => foldTrainKeys.has(b.raceKey))
    const foldTestBets = allBets.filter((b) => foldTestKeys.has(b.raceKey))

    console.log(`--- fold${fold}(test raceKey[${testStart}:${testEnd}], ${foldTestBets.length}件) ---`)
    console.log(`  フィルタなし\t${fmt(foldTestBets)}`)
    aggregateBaseline.push(...foldTestBets)

    for (const cfg of filterConfigs) {
      const tbl = buildWinRateTable(foldTrainBets, cfg.key)
      const filtered = foldTestBets.filter((b) => {
        const k = b[cfg.key]
        if (!k) return false
        return (tbl.table.get(String(k)) ?? tbl.globalMean) >= tbl.globalMean * cfg.mult
      })
      console.log(`  ${cfg.name}\t${fmt(filtered)}`)
      aggregate.get(cfg.name)!.push(...filtered)
    }
    console.log('')
  }

  console.log('=== 全fold合算(アウトオブサンプル全体) ===')
  console.log(`フィルタなし\t${fmt(aggregateBaseline)}`)
  for (const cfg of filterConfigs) {
    console.log(`${cfg.name}\t${fmt(aggregate.get(cfg.name)!)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
