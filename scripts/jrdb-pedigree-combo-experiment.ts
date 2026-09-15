// 検証済みの2つの独立シグナル(父馬×馬場適性、父馬×距離帯適性)を、1つのキーに結合するのではなく
// 「それぞれ別々に構築したフィルタの積集合(両方の条件を満たす馬だけ)」として組み合わせた場合の効果を検証する。
// (1つのキーに結合する方式は既にjrdb-distance-aptitude-experiment.tsで検証済みで、細分化しすぎて悪化した)
// 実行: npx tsx scripts/jrdb-pedigree-combo-experiment.ts
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

function distanceBucket(distance: number): string {
  if (distance <= 1400) return 'sprint'
  if (distance <= 1800) return 'mile'
  if (distance <= 2200) return 'middle'
  return 'long'
}

type EdgeBet = {
  raceKey: string
  win: boolean
  payout: number
  sireTrackKey: string
  sireDistanceKey: string
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
      // UKC未取得日は血統キーを空のままにする
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
        const sireName = ukc ? str(ukc.sireName) : ''
        const trackCode = num(sed.trackCode)
        const distance = num(sed.distance)
        const bucket = distance > 0 ? distanceBucket(distance) : ''
        bets.push({
          raceKey: `${dateStr8}-${key}`,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
          sireTrackKey: sireName && trackCode ? `${sireName}|${trackCode}` : '',
          sireDistanceKey: sireName && bucket ? `${sireName}|${bucket}` : '',
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

function passes(bet: EdgeBet, key: keyof EdgeBet, tbl: { table: Map<string, number>; globalMean: number }, mult: number): boolean {
  const k = bet[key]
  if (!k) return false
  return (tbl.table.get(String(k)) ?? tbl.globalMean) >= tbl.globalMean * mult
}

async function main() {
  console.log(`単勝バリューベット(エッジ+${(EDGE_THRESHOLD * 100).toFixed(0)}pt以上)に父馬×馬場・父馬×距離帯フィルタの積集合を重ねた場合の効果を検証\n`)
  const allBets = await collectEdgeBets()
  console.log(`エッジ条件を満たすベット総数: ${allBets.length}件\n`)

  const raceKeys = [...new Set(allBets.map((b) => b.raceKey))].sort()

  console.log('=== ウォークフォワード検証(5分割、各foldは直前までの全データで学習) ===\n')
  const FOLDS = 5
  const foldSize = Math.floor(raceKeys.length / FOLDS)
  const MULT = 1.2 // 単独で最も良かった閾値

  const labels = ['フィルタなし', '父馬×馬場のみ(参考)', '父馬×距離帯のみ(参考)', '父馬×馬場 AND 父馬×距離帯(積集合)']
  const aggregates = new Map<string, EdgeBet[]>(labels.map((l) => [l, []]))

  for (let fold = 1; fold < FOLDS; fold++) {
    const trainEnd = foldSize * fold
    const testStart = trainEnd
    const testEnd = fold === FOLDS - 1 ? raceKeys.length : foldSize * (fold + 1)
    const foldTrainKeys = new Set(raceKeys.slice(0, trainEnd))
    const foldTestKeys = new Set(raceKeys.slice(testStart, testEnd))
    const foldTrainBets = allBets.filter((b) => foldTrainKeys.has(b.raceKey))
    const foldTestBets = allBets.filter((b) => foldTestKeys.has(b.raceKey))

    const trackTbl = buildWinRateTable(foldTrainBets, 'sireTrackKey')
    const distTbl = buildWinRateTable(foldTrainBets, 'sireDistanceKey')

    const trackOnly = foldTestBets.filter((b) => passes(b, 'sireTrackKey', trackTbl, MULT))
    const distOnly = foldTestBets.filter((b) => passes(b, 'sireDistanceKey', distTbl, MULT))
    const both = foldTestBets.filter((b) => passes(b, 'sireTrackKey', trackTbl, MULT) && passes(b, 'sireDistanceKey', distTbl, MULT))

    console.log(`--- fold${fold}(test raceKey[${testStart}:${testEnd}], ${foldTestBets.length}件) ---`)
    console.log(`  フィルタなし\t${fmt(foldTestBets)}`)
    console.log(`  父馬×馬場のみ(参考)\t${fmt(trackOnly)}`)
    console.log(`  父馬×距離帯のみ(参考)\t${fmt(distOnly)}`)
    console.log(`  父馬×馬場 AND 父馬×距離帯(積集合)\t${fmt(both)}`)
    console.log('')

    aggregates.get('フィルタなし')!.push(...foldTestBets)
    aggregates.get('父馬×馬場のみ(参考)')!.push(...trackOnly)
    aggregates.get('父馬×距離帯のみ(参考)')!.push(...distOnly)
    aggregates.get('父馬×馬場 AND 父馬×距離帯(積集合)')!.push(...both)
  }

  console.log('=== 全fold合算(アウトオブサンプル全体) ===')
  for (const label of labels) {
    console.log(`${label}\t${fmt(aggregates.get(label)!)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
