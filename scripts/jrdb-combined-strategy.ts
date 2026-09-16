// 最終オッズ基準のバリューベット(エッジ+16pt→87.4%)を土台に、
// 検証済み・未検証のフィルタを重ねて100%超えを狙う。
//
// 重ねる候補:
//   1) オッズ変動: 前日→最終で大きく人気が下降した馬(2倍以上流れた=59.8%)を除外
//   2) 血統: 父馬×馬場適性 / 父馬×距離帯適性(勝率>=平均×1.2)
//   3) 新規解析フィールド: 万券指数、降級フラグ、ブリンカー初装着
//
// 血統テーブルは各foldのtrain期間のみから算出(リーク防止)。
// オッズ変動・エッジ・万券指数等は学習不要の直接計算なのでリークしない。
// 実行: npx tsx scripts/jrdb-combined-strategy.ts [ベースのエッジ閾値(既定12)]
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities, empiricalBayesShrink } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseTybBuffer, parseUkcBuffer, jrdbFileDate, type KyiRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SOFTMAX_TEMPERATURE = 8
const BASE_EDGE = Number(process.argv[2]) || 12 // 土台となる最終オッズ基準のエッジ閾値(%pt)

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function distanceBucket(distance: number): string {
  if (distance <= 1400) return 'sprint'
  if (distance <= 1800) return 'mile'
  if (distance <= 2200) return 'middle'
  return 'long'
}

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

type Bet = {
  raceKey: string
  win: boolean
  payout: number
  edgeFinal: number
  oddsRatio: number // 最終/前日(1未満=人気上昇)
  sireTrackKey: string
  sireDistKey: string
  jackpotIndex: number
  demotionFlag: number
  blinkerFirst: boolean
}

// ベースのエッジ条件を満たす馬だけを集める(母集団が小さいのでメモリに保持できる)
async function collectBets(): Promise<Bet[]> {
  const dates = (await listDatesWithTyb()).filter((d) => d < new Date())
  const bets: Bet[] = []
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
    let ukcByKetto: Map<string, UkcRow> | null = null
    try {
      const ukcRows = parseUkcBuffer(await fs.readFile(path.join(DATA_DIR, 'Ukc', `UKC${d8}.txt`)))
      ukcByKetto = new Map(ukcRows.map((r) => [str(r.kettoNumber), r]))
    } catch {
      // 血統が無い日は血統キーを空にする
    }

    const kyiRows = parseKyiBuffer(kyiBuf)
    const sedRows = parseSedBuffer(sedBuf)
    const tybMap = new Map(parseTybBuffer(tybBuf).map((t) => [`${t.venueCode}-${t.raceNumber}-${t.umaban}`, t]))

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

      const ourProbs = softmaxProbabilities(
        horses.map((h) => num(h.overallIndex)),
        SOFTMAX_TEMPERATURE,
      )
      const finalOdds = horses.map((h) => {
        const t = tybMap.get(`${venueCode}-${raceNumber}-${num(h.umaban)}`)
        return t ? num(t.finalOdds) : 0
      })
      if (finalOdds.some((o) => o <= 0)) continue
      const rawFinal = finalOdds.map((o) => 1 / o)
      const sumFinal = rawFinal.reduce((s, v) => s + v, 0)
      const probFinal = rawFinal.map((v) => v / sumFinal)

      for (let i = 0; i < horses.length; i++) {
        const edgeFinal = (ourProbs[i] - probFinal[i]) * 100
        if (edgeFinal < BASE_EDGE) continue // 土台の条件を満たさない馬は捨てる
        const before = num(horses[i].baseOdds)
        if (before <= 0) continue
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(horses[i].umaban),
        )
        if (!sed) continue

        const ukc = ukcByKetto?.get(str(horses[i].kettoNumber))
        const sireName = ukc ? str(ukc.sireName) : ''
        const trackCode = num(sed.trackCode)
        const distance = num(sed.distance)

        bets.push({
          raceKey: `${d8}-${key}`,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
          edgeFinal,
          oddsRatio: finalOdds[i] / before,
          sireTrackKey: sireName && trackCode ? `${sireName}|${trackCode}` : '',
          sireDistKey: sireName && distance ? `${sireName}|${distanceBucket(distance)}` : '',
          jackpotIndex: num(horses[i].jackpotIndex),
          demotionFlag: num(horses[i].demotionFlag),
          blinkerFirst: str(horses[i].blinker) === '1',
        })
      }
    }
    processed++
    if (processed % 300 === 0) console.log(`  ...${processed}/${dates.length}日`)
  }
  return bets
}

function buildRateTable(bets: Bet[], key: 'sireTrackKey' | 'sireDistKey') {
  const withKey = bets.filter((b) => b[key])
  const globalMean = withKey.length > 0 ? withKey.filter((b) => b.win).length / withKey.length : 0
  const stats = new Map<string, { wins: number; count: number }>()
  for (const b of withKey) {
    const cur = stats.get(b[key]) ?? { wins: 0, count: 0 }
    cur.count += 1
    if (b.win) cur.wins += 1
    stats.set(b[key], cur)
  }
  const table = new Map<string, number>()
  for (const [k, { wins, count }] of stats) {
    table.set(k, empiricalBayesShrink((wins / count) * 100, count, globalMean * 100, 20) / 100)
  }
  return { table, globalMean }
}

function fmt(bets: Bet[]) {
  const attempts = bets.length
  const hits = bets.filter((b) => b.win).length
  const stake = attempts * 100
  const payout = bets.reduce((s, b) => s + b.payout, 0)
  const hitRate = attempts > 0 ? Math.round((hits / attempts) * 1000) / 10 : 0
  const returnRate = stake > 0 ? Math.round((payout / stake) * 1000) / 10 : 0
  return `試行${String(attempts).padStart(5)}\t的中${String(hits).padStart(4)}\t的中率${hitRate}%\t回収率${returnRate}%`
}

async function main() {
  console.log(`=== 最終オッズ基準エッジ+${BASE_EDGE}pt以上を土台に、フィルタを重ねる ===\n`)
  const allBets = await collectBets()
  console.log(`\n土台の母集団: ${allBets.length.toLocaleString()}件\n`)

  const raceKeys = [...new Set(allBets.map((b) => b.raceKey))].sort()
  const FOLDS = 5
  const foldSize = Math.floor(raceKeys.length / FOLDS)

  // フィルタ定義。血統テーブルはfoldごとに作り直すため、テーブルを引数に取る形にする
  type Ctx = { track: Map<string, number>; trackMean: number; dist: Map<string, number>; distMean: number }
  const conditions: { name: string; f: (b: Bet, c: Ctx) => boolean }[] = [
    { name: '土台のみ(フィルタなし)', f: () => true },
    { name: '+ オッズ2倍以上流れた馬を除外', f: (b) => b.oddsRatio < 2.0 },
    { name: '+ オッズ下降馬を除外(1.25未満)', f: (b) => b.oddsRatio < 1.25 },
    { name: '+ 人気上昇馬のみ(0.8未満)', f: (b) => b.oddsRatio < 0.8 },
    { name: '+ 父馬×馬場適性>=平均×1.2', f: (b, c) => !!b.sireTrackKey && (c.track.get(b.sireTrackKey) ?? c.trackMean) >= c.trackMean * 1.2 },
    { name: '+ 父馬×距離帯適性>=平均×1.2', f: (b, c) => !!b.sireDistKey && (c.dist.get(b.sireDistKey) ?? c.distMean) >= c.distMean * 1.2 },
    { name: '+ 万券指数>=50', f: (b) => b.jackpotIndex >= 50 },
    { name: '+ 万券指数>=70', f: (b) => b.jackpotIndex >= 70 },
    { name: '+ 降級馬のみ', f: (b) => b.demotionFlag >= 1 },
    { name: '+ ブリンカー初装着のみ', f: (b) => b.blinkerFirst },
    // 組み合わせ
    { name: '★ オッズ<1.25 かつ 父馬×馬場>=1.2', f: (b, c) => b.oddsRatio < 1.25 && !!b.sireTrackKey && (c.track.get(b.sireTrackKey) ?? c.trackMean) >= c.trackMean * 1.2 },
    { name: '★ オッズ<0.8 かつ 父馬×馬場>=1.2', f: (b, c) => b.oddsRatio < 0.8 && !!b.sireTrackKey && (c.track.get(b.sireTrackKey) ?? c.trackMean) >= c.trackMean * 1.2 },
    { name: '★ オッズ<1.25 かつ 父馬×距離帯>=1.2', f: (b, c) => b.oddsRatio < 1.25 && !!b.sireDistKey && (c.dist.get(b.sireDistKey) ?? c.distMean) >= c.distMean * 1.2 },
  ]

  const aggregate = new Map<string, Bet[]>(conditions.map((c) => [c.name, []]))
  const perFold: Map<string, number[]> = new Map(conditions.map((c) => [c.name, []]))

  for (let fold = 1; fold < FOLDS; fold++) {
    const trainEnd = foldSize * fold
    const testEnd = fold === FOLDS - 1 ? raceKeys.length : foldSize * (fold + 1)
    const trainKeys = new Set(raceKeys.slice(0, trainEnd))
    const testKeys = new Set(raceKeys.slice(trainEnd, testEnd))
    const trainBets = allBets.filter((b) => trainKeys.has(b.raceKey))
    const testBets = allBets.filter((b) => testKeys.has(b.raceKey))

    const t = buildRateTable(trainBets, 'sireTrackKey')
    const d = buildRateTable(trainBets, 'sireDistKey')
    const ctx: Ctx = { track: t.table, trackMean: t.globalMean, dist: d.table, distMean: d.globalMean }

    for (const c of conditions) {
      const filtered = testBets.filter((b) => c.f(b, ctx))
      aggregate.get(c.name)!.push(...filtered)
      const stake = filtered.length * 100
      const payout = filtered.reduce((s, b) => s + b.payout, 0)
      perFold.get(c.name)!.push(stake > 0 ? Math.round((payout / stake) * 1000) / 10 : 0)
    }
  }

  console.log('=== 全fold合算(アウトオブサンプル) ===')
  for (const c of conditions) {
    console.log(`${c.name.padEnd(34)}\t${fmt(aggregate.get(c.name)!)}`)
  }

  console.log('\n=== fold別の回収率(一貫性の確認) ===')
  for (const c of conditions) {
    console.log(`${c.name.padEnd(34)}\t${perFold.get(c.name)!.map((v) => `${v}%`).join(' / ')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
