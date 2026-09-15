// 検証済みの単勝バリューベット(総合指数vs市場オッズのエッジ)に、血統(父馬・母父馬の勝率)を
// 追加フィルタとして組み合わせた場合、回収率がさらに改善するかを検証する。
// 血統勝率テーブルはtrain期間(古い80%)のみから算出し、test期間(新しい20%)で評価してリークを防ぐ
// (train/testの分け方はjrdb-train-model.tsと同じ手法)。
// 実行: npx tsx scripts/jrdb-value-bet-pedigree-experiment.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities, empiricalBayesShrink } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseUkcBuffer, type KyiRow, type SedRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SOFTMAX_TEMPERATURE = 8
const EDGE_THRESHOLD = 0.08 // 検証済みの単勝バリューベット閾値

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
  dateStr8: string
  raceKey: string
  win: boolean
  payout: number
  sireName: string
  damSireName: string
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
      // UKC未取得の日はこのレースを血統フィルタ対象から除外(sireNameを空のままにして後段でスキップ)
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
        bets.push({
          dateStr8,
          raceKey: `${dateStr8}-${key}`,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
          sireName: ukc ? str(ukc.sireName) : '',
          damSireName: ukc ? str(ukc.damSireName) : '',
        })
      }
    }
  }
  return bets
}

function buildPedigreeWinRates(bets: EdgeBet[], key: 'sireName' | 'damSireName'): { table: Map<string, number>; globalMean: number } {
  const withName = bets.filter((b) => b[key])
  const globalMean = withName.filter((b) => b.win).length / (withName.length || 1)
  const stats = new Map<string, { wins: number; count: number }>()
  for (const b of withName) {
    const name = b[key]
    const cur = stats.get(name) ?? { wins: 0, count: 0 }
    cur.count += 1
    if (b.win) cur.wins += 1
    stats.set(name, cur)
  }
  const table = new Map<string, number>()
  for (const [name, { wins, count }] of stats) {
    table.set(name, empiricalBayesShrink((wins / count) * 100, count, globalMean * 100, 20) / 100)
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
  console.log(`単勝バリューベット(エッジ+${(EDGE_THRESHOLD * 100).toFixed(0)}pt以上)に血統フィルタを重ねた場合の効果を検証\n`)
  const allBets = await collectEdgeBets()
  console.log(`エッジ条件を満たすベット総数: ${allBets.length}件(うち血統判明: ${allBets.filter((b) => b.sireName).length}件)\n`)

  // 時系列でtrain(古い80%)/test(新しい20%)に分割(血統テーブルのリーク防止)
  const raceKeys = [...new Set(allBets.map((b) => b.raceKey))].sort()
  const splitIdx = Math.floor(raceKeys.length * 0.8)
  const trainRaceKeys = new Set(raceKeys.slice(0, splitIdx))
  const trainBets = allBets.filter((b) => trainRaceKeys.has(b.raceKey))
  const testBets = allBets.filter((b) => !trainRaceKeys.has(b.raceKey))
  console.log(`train: ${trainBets.length}件 / test: ${testBets.length}件\n`)

  const sireStats = buildPedigreeWinRates(trainBets, 'sireName')
  const damSireStats = buildPedigreeWinRates(trainBets, 'damSireName')
  console.log(`父馬の平均勝率(train, 血統フィルタ対象母集団内): ${(sireStats.globalMean * 100).toFixed(1)}%`)
  console.log(`母父馬の平均勝率(train, 同上): ${(damSireStats.globalMean * 100).toFixed(1)}%\n`)

  console.log('=== testデータでの回収率比較(単勝バリューベット、エッジ+8pt以上が前提) ===')
  console.log(`全体(血統フィルタなし)\t${fmt(testBets)}`)

  const withPedigree = testBets.filter((b) => b.sireName)
  console.log(`血統判明分のみ\t${fmt(withPedigree)}`)

  for (const mult of [1.0, 1.05, 1.1, 1.2]) {
    const sireFiltered = withPedigree.filter((b) => (sireStats.table.get(b.sireName) ?? sireStats.globalMean) >= sireStats.globalMean * mult)
    console.log(`父馬勝率>=平均×${mult}\t${fmt(sireFiltered)}`)
  }
  for (const mult of [1.0, 1.05, 1.1, 1.2]) {
    const damSireFiltered = withPedigree.filter(
      (b) => (damSireStats.table.get(b.damSireName) ?? damSireStats.globalMean) >= damSireStats.globalMean * mult,
    )
    console.log(`母父馬勝率>=平均×${mult}\t${fmt(damSireFiltered)}`)
  }
  // 父馬・母父馬どちらも平均以上
  const both = withPedigree.filter(
    (b) =>
      (sireStats.table.get(b.sireName) ?? sireStats.globalMean) >= sireStats.globalMean &&
      (damSireStats.table.get(b.damSireName) ?? damSireStats.globalMean) >= damSireStats.globalMean,
  )
  console.log(`父馬・母父馬どちらも平均以上\t${fmt(both)}`)

  // --- ウォークフォワード検証: 単一splitのノイズでないか、複数の独立したテスト期間で確認する ---
  console.log('\n=== ウォークフォワード検証(5分割、各foldは直前までの全データで学習) ===')
  const FOLDS = 5
  const foldSize = Math.floor(raceKeys.length / FOLDS)
  for (let fold = 1; fold < FOLDS; fold++) {
    const trainEnd = foldSize * fold
    const testStart = trainEnd
    const testEnd = fold === FOLDS - 1 ? raceKeys.length : foldSize * (fold + 1)
    const foldTrainKeys = new Set(raceKeys.slice(0, trainEnd))
    const foldTestKeys = new Set(raceKeys.slice(testStart, testEnd))
    const foldTrainBets = allBets.filter((b) => foldTrainKeys.has(b.raceKey))
    const foldTestBets = allBets.filter((b) => foldTestKeys.has(b.raceKey)).filter((b) => b.sireName)

    const foldDamSireStats = buildPedigreeWinRates(foldTrainBets, 'damSireName')
    const foldBaseline = foldTestBets
    const foldFiltered = foldTestBets.filter(
      (b) => (foldDamSireStats.table.get(b.damSireName) ?? foldDamSireStats.globalMean) >= foldDamSireStats.globalMean * 1.1,
    )
    console.log(`fold${fold}(test期間 raceKey[${testStart}:${testEnd}])`)
    console.log(`  フィルタなし\t${fmt(foldBaseline)}`)
    console.log(`  母父馬勝率>=平均×1.1\t${fmt(foldFiltered)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
