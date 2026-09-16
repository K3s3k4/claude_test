// バリューベットのエッジを「前日オッズ(KYI基準オッズ)」ではなく
// 「最終オッズ(TYB・発走約15分前)」を基準に測り直す。
//
// これまでの全検証はKYIの基準オッズを市場の総意として扱ってきたが、
// KYIは金曜19時/土曜20時に作成されるため前日の値であり、発走までに平均48.7%変動する。
// 最終オッズで測り直すことで、市場が最終的に織り込んだ値との真の乖離が分かる。
//
// 比較する内容:
//   A) 前日オッズ基準(従来手法)
//   B) 最終オッズ基準
//   C) オッズの動きそのもの(前日→最終で人気が上がった/下がった馬)
//   D) 前日にエッジがあった馬のうち、市場が最後まで修正しなかった馬 vs 修正した馬
//
// 10年分・延べ48万頭を配列に保持するとメモリが尽きるため、日ごとに集計して捨てるストリーム処理にする。
// 実行: npx tsx scripts/jrdb-final-odds-value-bet.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseTybBuffer, jrdbFileDate, type KyiRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SOFTMAX_TEMPERATURE = 8
const THRESHOLDS = [0, 4, 8, 12, 16, 20, 25, 30]

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

async function listDatesWithTyb(): Promise<Date[]> {
  const dir = path.join(DATA_DIR, 'Tyb')
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const dates: Date[] = []
  for (const f of files) {
    const m = f.match(/^TYB(\d{2})(\d{2})(\d{2})\.txt$/)
    if (!m) continue
    dates.push(jrdbFileDate(m[1], m[2], m[3]))
  }
  return dates.sort((a, b) => a.getTime() - b.getTime())
}

type Counter = { attempts: number; hits: number; stake: number; payout: number }
const newCounter = (): Counter => ({ attempts: 0, hits: 0, stake: 0, payout: 0 })
function add(c: Counter, win: boolean, payout: number) {
  c.attempts += 1
  if (win) c.hits += 1
  c.stake += 100
  c.payout += payout
}
function fmt(c: Counter) {
  const hitRate = c.attempts > 0 ? Math.round((c.hits / c.attempts) * 1000) / 10 : 0
  const returnRate = c.stake > 0 ? Math.round((c.payout / c.stake) * 1000) / 10 : 0
  return `試行${c.attempts}\t的中${c.hits}\t的中率${hitRate}%\t回収率${returnRate}%`
}

async function main() {
  console.log('=== 前日オッズ vs 最終オッズ でバリューベットのエッジを測り直す ===\n')

  const dates = (await listDatesWithTyb()).filter((d) => d < new Date())
  console.log(`対象日数: ${dates.length}日(TYBが揃っている日)\n`)

  const beforeCounters = new Map(THRESHOLDS.map((t) => [t, newCounter()]))
  const finalCounters = new Map(THRESHOLDS.map((t) => [t, newCounter()]))
  const moveBuckets: { name: string; test: (ratio: number) => boolean; c: Counter }[] = [
    { name: '大きく人気上昇(最終/前日 <0.5)', test: (r) => r < 0.5, c: newCounter() },
    { name: '人気上昇(0.5〜0.8)', test: (r) => r >= 0.5 && r < 0.8, c: newCounter() },
    { name: 'ほぼ変化なし(0.8〜1.25)', test: (r) => r >= 0.8 && r < 1.25, c: newCounter() },
    { name: '人気下降(1.25〜2.0)', test: (r) => r >= 1.25 && r < 2.0, c: newCounter() },
    { name: '大きく人気下降(>=2.0)', test: (r) => r >= 2.0, c: newCounter() },
  ]
  const bothEdge = newCounter() // 前日も最終もエッジ+8pt以上(市場が最後まで修正しなかった)
  const onlyBeforeEdge = newCounter() // 前日のみ(発走までに市場が修正した)
  let totalHorses = 0
  let processed = 0

  for (const date of dates) {
    const d8 = toYymmdd(date)
    let kyiBuf: Buffer
    let sedBuf: Buffer
    let tybBuf: Buffer
    try {
      kyiBuf = await fs.readFile(path.join(DATA_DIR, 'Kyi', `KYI${d8}.txt`))
      sedBuf = await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${d8}.txt`))
      tybBuf = await fs.readFile(path.join(DATA_DIR, 'Tyb', `TYB${d8}.txt`))
    } catch {
      continue
    }
    const kyiRows = parseKyiBuffer(kyiBuf)
    const sedRows = parseSedBuffer(sedBuf)
    const tybRows = parseTybBuffer(tybBuf)
    const tybMap = new Map(tybRows.map((t) => [`${t.venueCode}-${t.raceNumber}-${t.umaban}`, t]))

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

      const ourProbs = softmaxProbabilities(
        horses.map((h) => num(h.overallIndex)),
        SOFTMAX_TEMPERATURE,
      )

      const rawBefore = horses.map((h) => {
        const o = num(h.baseOdds)
        return o > 0 ? 1 / o : 0
      })
      const sumBefore = rawBefore.reduce((s, v) => s + v, 0)
      if (sumBefore <= 0) continue
      const probBefore = rawBefore.map((v) => v / sumBefore)

      const finalOdds = horses.map((h) => {
        const t = tybMap.get(`${venueCode}-${raceNumber}-${num(h.umaban)}`)
        return t ? num(t.finalOdds) : 0
      })
      if (finalOdds.some((o) => o <= 0)) continue // 最終オッズが揃わないレースは除外
      const rawFinal = finalOdds.map((o) => 1 / o)
      const sumFinal = rawFinal.reduce((s, v) => s + v, 0)
      const probFinal = rawFinal.map((v) => v / sumFinal)

      for (let i = 0; i < horses.length; i++) {
        const before = num(horses[i].baseOdds)
        if (before <= 0) continue
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(horses[i].umaban),
        )
        if (!sed) continue

        const win = num(sed.tanshoPayout) > 0
        const payout = num(sed.tanshoPayout)
        const edgeBefore = (ourProbs[i] - probBefore[i]) * 100
        const edgeFinal = (ourProbs[i] - probFinal[i]) * 100
        const ratio = finalOdds[i] / before
        totalHorses++

        for (const t of THRESHOLDS) {
          if (edgeBefore >= t) add(beforeCounters.get(t)!, win, payout)
          if (edgeFinal >= t) add(finalCounters.get(t)!, win, payout)
        }
        for (const b of moveBuckets) if (b.test(ratio)) add(b.c, win, payout)
        if (edgeBefore >= 8) {
          if (edgeFinal >= 8) add(bothEdge, win, payout)
          else add(onlyBeforeEdge, win, payout)
        }
      }
    }
    processed++
    if (processed % 200 === 0) console.log(`  ...${processed}/${dates.length}日 処理済み`)
  }

  console.log(`\n対象: ${totalHorses.toLocaleString()}頭\n`)

  console.log('【A) 前日オッズ基準(従来手法)】')
  for (const t of THRESHOLDS) console.log(`  エッジ>=${t}pt\t${fmt(beforeCounters.get(t)!)}`)

  console.log('\n【B) 最終オッズ基準(発走15分前)】')
  for (const t of THRESHOLDS) console.log(`  エッジ>=${t}pt\t${fmt(finalCounters.get(t)!)}`)

  console.log('\n【C) オッズの動きそのもの(前日→最終)】')
  for (const b of moveBuckets) console.log(`  ${b.name}\t${fmt(b.c)}`)

  console.log('\n【D) 前日エッジ+8pt以上の馬を、市場が修正したかで分ける】')
  console.log(`  市場が最後まで修正しなかった(最終もエッジ+8pt以上)\t${fmt(bothEdge)}`)
  console.log(`  市場が発走までに修正した(最終はエッジ+8pt未満)    \t${fmt(onlyBeforeEdge)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
