// 三連単は「事前のコンビ別市場オッズ」がJRDBの取得データに存在しないため、
// 単勝と同じ意味でのバリューベット(市場確率との比較)はできない。
// 代わりに「単勝バリュー(市場より自分の予想が高い馬)を示した馬だけでボックスを組む」戦略を検証する。
// 実行: npx tsx scripts/jrdb-sanrentan-value-experiment.ts [temperature]
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities, trifectaOrderProbability } from '../server/probability'
import { parseKyiBuffer, parseHjcBuffer, type KyiRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SOFTMAX_TEMPERATURE = Number(process.argv[2]) || 8

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

function permutations3(idx: number[]): [number, number, number][] {
  const out: [number, number, number][] = []
  for (const a of idx) for (const b of idx) for (const c of idx) {
    if (a !== b && b !== c && a !== c) out.push([a, b, c])
  }
  return out
}

async function main() {
  const dates = await listAvailableDates()
  const pastDates = dates.filter((d) => d < new Date())
  console.log(`対象日数: ${pastDates.length}日 (softmax温度=${SOFTMAX_TEMPERATURE})\n`)

  // 基準: 現行方式(総合指数トップ5でボックス、確率上位3点購入)
  const baseline = { attempts: 0, hits: 0, stake: 0, payout: 0 }
  // 提案: 単勝バリューエッジが閾値以上の馬だけでボックスを組む(確率上位3点購入)
  const edgeThresholds = [0, 0.02, 0.04, 0.06]
  const results: Record<number, { attempts: number; hits: number; stake: number; payout: number }> = {}
  for (const t of edgeThresholds) results[t] = { attempts: 0, hits: 0, stake: 0, payout: 0 }

  for (const date of pastDates) {
    const dateStr8 = toYymmdd(date)
    let kyiBuf: Buffer
    let hjcBuf: Buffer
    try {
      kyiBuf = await fs.readFile(path.join(DATA_DIR, 'Kyi', `KYI${dateStr8}.txt`))
      hjcBuf = await fs.readFile(path.join(DATA_DIR, 'Hjc', `HJC${dateStr8}.txt`))
    } catch {
      continue
    }
    const kyiRows = parseKyiBuffer(kyiBuf)
    const hjcRaces = parseHjcBuffer(hjcBuf)

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

      const rawMarket = horses.map((h) => (num(h.baseOdds) > 0 ? 1 / num(h.baseOdds) : 0))
      const marketSum = rawMarket.reduce((s, v) => s + v, 0)
      const marketProbs = marketSum > 0 ? rawMarket.map((v) => v / marketSum) : rawMarket
      const edges = horses.map((_, i) => winProbs[i] - marketProbs[i])

      const hjcEntry = hjcRaces.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)
      const actualSanrentan = hjcEntry?.payouts.sanrentan ?? []
      if (actualSanrentan.length === 0) continue // 結果未確定 or 不成立

      function settle(boxIdx: number[], target: typeof baseline) {
        if (boxIdx.length < 3) return
        const axis = boxIdx[0]
        const flow = boxIdx.slice(1)
        const combos = permutations3([axis, ...flow])
          .filter(([a]) => a === axis)
          .map(([a, b, c]) => ({ picks: [a, b, c], prob: trifectaOrderProbability(winProbs[a], winProbs[b], winProbs[c]) }))
          .sort((x, y) => y.prob - x.prob)
          .slice(0, 3)
        for (const combo of combos) {
          const umabans = combo.picks.map((i) => num(horses[i].umaban))
          target.attempts += 1
          target.stake += 100
          const hit = actualSanrentan.find((e) => e.combo.length === 3 && e.combo[0] === umabans[0] && e.combo[1] === umabans[1] && e.combo[2] === umabans[2])
          if (hit) {
            target.hits += 1
            target.payout += hit.payoutYen
          }
        }
      }

      // 基準: 総合指数トップ5(0-index)
      const byScoreDesc = horses.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
      settle(byScoreDesc.slice(0, 5), baseline)

      // 提案: エッジ >= threshold の馬だけ(スコア降順で並べてaxisは最上位)
      for (const t of edgeThresholds) {
        const eligible = horses
          .map((_, i) => i)
          .filter((i) => edges[i] >= t)
          .sort((a, b) => scores[b] - scores[a])
        settle(eligible.slice(0, 5), results[t])
      }
    }
  }

  console.log('戦略\t試行数\t的中数\t的中率\t回収率')
  const bHit = baseline.attempts > 0 ? Math.round((baseline.hits / baseline.attempts) * 1000) / 10 : 0
  const bRet = baseline.stake > 0 ? Math.round((baseline.payout / baseline.stake) * 1000) / 10 : 0
  console.log(`現行(総合指数トップ5でボックス)\t${baseline.attempts}\t${baseline.hits}\t${bHit}%\t${bRet}%`)
  for (const t of edgeThresholds) {
    const r = results[t]
    const hitRate = r.attempts > 0 ? Math.round((r.hits / r.attempts) * 1000) / 10 : 0
    const returnRate = r.stake > 0 ? Math.round((r.payout / r.stake) * 1000) / 10 : 0
    console.log(`単勝エッジ+${(t * 100).toFixed(0)}pt以上の馬でボックス\t${r.attempts}\t${r.hits}\t${hitRate}%\t${returnRate}%`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
