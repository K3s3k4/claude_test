// 血統を「勝率」ではなく「回収率」で評価する。
//
// これまでの血統検証は全て勝率を指標にしていたが、勝率は市場が既に織り込んでいる情報のため
// 優位性が出なかった(最終オッズで測り直したら効果が消えた)。
// 実務の血統データ分析では「全馬を買うと回収率は控除率ぶんの約80%に収束するので、
// 80%を超える種牡馬は過小評価されている」という考え方が使われている。
// つまり回収率で測れば「市場が安く評価しすぎている血統」を直接特定できる。
//
// 本スクリプトの核心は【持続性の検証】:
//   過去期間に回収率が高かった種牡馬は、将来期間でも回収率が高いのか?
//   高くないなら、それは単なる過去のノイズであり馬券には使えない。
//
// メモリ対策として、馬ごとのレコードは保持せず「種牡馬×fold」の集計カウンタだけを積む。
// 実行: npx tsx scripts/jrdb-sire-roi-persistence.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { empiricalBayesShrink } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseUkcBuffer, jrdbFileDate, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const FOLDS = 5
const SHRINK_K = 100 // 回収率は配当の分散が大きいため、勝率より強めに全体平均へ縮める

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function distanceBucket(d: number): string {
  if (d <= 1400) return 'sprint'
  if (d <= 1800) return 'mile'
  if (d <= 2200) return 'middle'
  return 'long'
}

async function listDates(): Promise<Date[]> {
  const dir = path.join(DATA_DIR, 'Kyi')
  const files = await fs.readdir(dir)
  const dates: Date[] = []
  for (const f of files) {
    const m = f.match(/^KYI(\d{2})(\d{2})(\d{2})\.txt$/)
    if (!m) continue
    dates.push(jrdbFileDate(m[1], m[2], m[3]))
  }
  return dates.sort((a, b) => a.getTime() - b.getTime()).filter((d) => d < new Date())
}

type Counter = { bets: number; wins: number; payout: number }
const newCounter = (): Counter => ({ bets: 0, wins: 0, payout: 0 })
function addTo(map: Map<string, Counter>, key: string, win: boolean, payout: number) {
  const c = map.get(key) ?? newCounter()
  c.bets += 1
  if (win) c.wins += 1
  c.payout += payout
  map.set(key, c)
}
const roiOf = (c: Counter) => (c.bets > 0 ? (c.payout / (c.bets * 100)) * 100 : 0)

// 集計する切り口。キーの作り方だけが違う。
type Angle = { name: string; key: (ctx: HorseCtx) => string }
type HorseCtx = {
  sire: string
  damSire: string
  trackCode: number
  distance: number
  venueCode: string
  trackCondition: number
}
const ANGLES: Angle[] = [
  { name: '父馬', key: (c) => c.sire },
  { name: '父馬×馬場(芝ダ)', key: (c) => `${c.sire}|${c.trackCode}` },
  { name: '父馬×距離帯', key: (c) => `${c.sire}|${distanceBucket(c.distance)}` },
  { name: '父馬×競馬場', key: (c) => `${c.sire}|${c.venueCode}` },
  { name: '父馬×馬場状態', key: (c) => `${c.sire}|${c.trackCondition}` },
  { name: 'ニックス(父×母父)', key: (c) => `${c.sire}|${c.damSire}` },
  { name: '母父馬', key: (c) => c.damSire },
]

async function main() {
  console.log('=== 血統を「回収率」で評価し、その持続性を検証する ===')
  console.log('(全馬買いの回収率は控除率ぶん約75-80%に収束する。これを超える血統=市場の過小評価)\n')

  const dates = await listDates()
  const foldSize = Math.floor(dates.length / FOLDS)
  const foldOfDate = new Map<string, number>()
  dates.forEach((d, i) => {
    const f = Math.min(Math.floor(i / foldSize), FOLDS - 1)
    foldOfDate.set(toYymmdd(d), f)
  })
  console.log(`対象: ${dates.length}日を${FOLDS}分割(1foldあたり約${foldSize}日)\n`)

  // angle名 -> fold -> キー -> カウンタ
  const stats = new Map<string, Map<number, Map<string, Counter>>>()
  for (const a of ANGLES) {
    const byFold = new Map<number, Map<string, Counter>>()
    for (let f = 0; f < FOLDS; f++) byFold.set(f, new Map())
    stats.set(a.name, byFold)
  }
  const overallByFold = new Map<number, Counter>()
  for (let f = 0; f < FOLDS; f++) overallByFold.set(f, newCounter())

  let processed = 0
  let totalHorses = 0

  for (const date of dates) {
    const d8 = toYymmdd(date)
    const fold = foldOfDate.get(d8)!
    let kyiBuf: Buffer
    let sedBuf: Buffer
    try {
      kyiBuf = await fs.readFile(path.join(DATA_DIR, 'Kyi', `KYI${d8}.txt`))
      sedBuf = await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${d8}.txt`))
    } catch {
      continue
    }
    let ukcByKetto: Map<string, UkcRow>
    try {
      const ukcRows = parseUkcBuffer(await fs.readFile(path.join(DATA_DIR, 'Ukc', `UKC${d8}.txt`)))
      ukcByKetto = new Map(ukcRows.map((r) => [str(r.kettoNumber), r]))
    } catch {
      continue
    }

    const kyiRows = parseKyiBuffer(kyiBuf)
    const sedRows = parseSedBuffer(sedBuf)

    for (const h of kyiRows) {
      const venueCode = String(h.venueCode)
      const raceNumber = Number(h.raceNumber)
      const sed = sedRows.find(
        (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(h.umaban),
      )
      if (!sed) continue
      const ukc = ukcByKetto.get(str(h.kettoNumber))
      if (!ukc) continue
      const sire = str(ukc.sireName)
      if (!sire) continue

      const ctx: HorseCtx = {
        sire,
        damSire: str(ukc.damSireName),
        trackCode: num(sed.trackCode),
        distance: num(sed.distance),
        venueCode,
        trackCondition: num(sed.trackCondition),
      }
      const win = num(sed.tanshoPayout) > 0
      const payout = num(sed.tanshoPayout)
      totalHorses++

      const oc = overallByFold.get(fold)!
      oc.bets += 1
      if (win) oc.wins += 1
      oc.payout += payout

      for (const a of ANGLES) {
        const k = a.key(ctx)
        // 空のキーや、母父不明などで片側が欠けた組み合わせキーは集計しない
        if (!k || k.split('|').some((part) => part === '' || part === '0')) continue
        addTo(stats.get(a.name)!.get(fold)!, k, win, payout)
      }
    }

    processed++
    if (processed % 300 === 0) console.log(`  ...${processed}/${dates.length}日`)
  }

  console.log(`\n対象: ${totalHorses.toLocaleString()}頭\n`)
  console.log('全馬買いの回収率(fold別):')
  for (let f = 0; f < FOLDS; f++) {
    const c = overallByFold.get(f)!
    console.log(`  fold${f}: ${roiOf(c).toFixed(1)}% (${c.bets.toLocaleString()}頭)`)
  }

  // --- 持続性の検証: 学習期間で回収率が高かった血統は、テスト期間でも高いか? ---
  console.log('\n=== 持続性の検証 ===')
  console.log('学習期間の回収率で血統を5段階に分け、テスト期間での実際の回収率を見る\n')

  for (const a of ANGLES) {
    const byFold = stats.get(a.name)!
    // 5段階のテスト期間カウンタ
    const buckets = [newCounter(), newCounter(), newCounter(), newCounter(), newCounter()]
    const labels = ['最低20%', '下位20-40%', '中位40-60%', '上位60-80%', '最高20%']

    for (let testFold = 1; testFold < FOLDS; testFold++) {
      // 学習: testFoldより前の全fold
      const train = new Map<string, Counter>()
      let trainTotal = newCounter()
      for (let f = 0; f < testFold; f++) {
        for (const [k, c] of byFold.get(f)!) {
          const cur = train.get(k) ?? newCounter()
          cur.bets += c.bets
          cur.wins += c.wins
          cur.payout += c.payout
          train.set(k, cur)
          trainTotal.bets += c.bets
          trainTotal.payout += c.payout
        }
      }
      const trainMean = roiOf(trainTotal)

      // 学習期間の回収率(経験ベイズで全体平均へ縮める)
      const shrunk = new Map<string, number>()
      for (const [k, c] of train) {
        shrunk.set(k, empiricalBayesShrink(roiOf(c), c.bets, trainMean, SHRINK_K))
      }
      // 5段階の境界を決める(学習期間に十分な出走があるものだけ)
      const eligible = [...shrunk.entries()].filter(([k]) => (train.get(k)?.bets ?? 0) >= 50)
      if (eligible.length < 10) continue
      const sortedVals = eligible.map(([, v]) => v).sort((x, y) => x - y)
      const cut = (p: number) => sortedVals[Math.floor(sortedVals.length * p)]
      const cuts = [cut(0.2), cut(0.4), cut(0.6), cut(0.8)]

      // テスト期間の実績を、学習期間の段階ごとに集計
      for (const [k, c] of byFold.get(testFold)!) {
        const v = shrunk.get(k)
        if (v === undefined || (train.get(k)?.bets ?? 0) < 50) continue
        let b = 0
        while (b < 4 && v >= cuts[b]) b++
        buckets[b].bets += c.bets
        buckets[b].wins += c.wins
        buckets[b].payout += c.payout
      }
    }

    const total = buckets.reduce((s, b) => s + b.bets, 0)
    if (total === 0) continue
    console.log(`【${a.name}】`)
    for (let i = 0; i < 5; i++) {
      const b = buckets[i]
      const hitRate = b.bets > 0 ? ((b.wins / b.bets) * 100).toFixed(1) : '0'
      console.log(`  学習期間${labels[i].padEnd(10)} → テスト期間の回収率 ${roiOf(b).toFixed(1)}%\t(的中率${hitRate}% / 試行${b.bets.toLocaleString()})`)
    }
    const top = roiOf(buckets[4])
    const bottom = roiOf(buckets[0])
    console.log(`  → 最高20%と最低20%の差: ${(top - bottom).toFixed(1)}pt ${top - bottom > 5 ? '(持続性あり)' : '(持続性なし=ノイズ)'}\n`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
