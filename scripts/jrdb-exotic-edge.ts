// 複勝で確立した手法(最終オッズのエッジ × 血統 × 指数確信度)を、馬連・ワイドに展開する。
//
// 制約: JRDBには馬連・ワイドのオッズファイル(OZ/OW)が存在するが仕様書が非公開で、
// バイト構造を確定できなかった。誤った解析で誤った結論を出すリスクを避けるため、
// 市場の組み合わせ確率は「TYBの最終単勝オッズ → 市場の勝率 → Harville法」で導出する。
// 我々の確率も同じ変換(JRDB指数 → softmax → Harville法)で作るので比較は公平。
// 払戻は既に正確に解析できているHJC(全券種の確定配当)を使う。
//
// 問い: 単勝・複勝で見つけたエッジは、配当の大きい馬連・ワイドでより稼げるのか?
//   馬連・ワイドは控除率が高い(約22.5-25%)が、その分だけ市場の歪みも大きい可能性がある。
// 実行: npx tsx scripts/jrdb-exotic-edge.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities, quinellaProbability, wideProbability, empiricalBayesShrink } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseTybBuffer, parseUkcBuffer, parseHjcBuffer, jrdbFileDate, type KyiRow, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const FOLDS = 5
const SOFTMAX_TEMPERATURE = 8
const SHRINK = { sire: 80, surface: 120, going: 150, distance: 150 }

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
  return dates.sort((a, b) => a.getTime() - b.getTime()).filter((d) => d < new Date())
}

// 買い目1点ぶん(2頭の組み合わせ)
type Bet = {
  fold: number
  edge: number // 我々の確率 - 市場の確率(%pt)
  indexGap: number // レース単位: 指数1位と2位の勝率差
  pedigreeScoreA: number // 2頭それぞれの血統スコアの平均を後で使う
  pedigreeScoreB: number
  umarenWin: boolean
  umarenPayout: number
  wideWin: boolean
  widePayout: number
}
// 血統スコアを後から計算するため、集計前の素材も持つ
type RawBet = Omit<Bet, 'pedigreeScoreA' | 'pedigreeScoreB'> & {
  sireA: string
  surfA: string
  goingA: string
  distA: string
  sireB: string
  surfB: string
  goingB: string
  distB: string
}
// 血統モデルの学習用(馬単位)
type HorseRow = { fold: number; sire: string; surfaceKey: string; goingKey: string; distKey: string; payout: number }

const comboKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)

async function collect(): Promise<{ bets: RawBet[]; horses: HorseRow[] }> {
  const dates = await listDatesWithTyb()
  const foldSize = Math.floor(dates.length / FOLDS)
  const foldOf = new Map<string, number>()
  dates.forEach((d, i) => foldOf.set(toYymmdd(d), Math.min(Math.floor(i / foldSize), FOLDS - 1)))

  const bets: RawBet[] = []
  const horses: HorseRow[] = []
  let processed = 0

  for (const date of dates) {
    const d8 = toYymmdd(date)
    const fold = foldOf.get(d8)!
    let kyiBuf: Buffer
    let sedBuf: Buffer
    let tybBuf: Buffer
    let hjcBuf: Buffer
    try {
      kyiBuf = await fs.readFile(path.join(DATA_DIR, 'Kyi', `KYI${d8}.txt`))
      sedBuf = await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${d8}.txt`))
      tybBuf = await fs.readFile(path.join(DATA_DIR, 'Tyb', `TYB${d8}.txt`))
      hjcBuf = await fs.readFile(path.join(DATA_DIR, 'Hjc', `HJC${d8}.txt`))
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
    const tybMap = new Map(parseTybBuffer(tybBuf).map((t) => [`${t.venueCode}-${t.raceNumber}-${t.umaban}`, t]))
    const hjcRaces = parseHjcBuffer(hjcBuf)

    const grouped = new Map<string, KyiRow[]>()
    for (const r of kyiRows) {
      const key = `${r.venueCode}-${r.raceNumber}`
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(r)
    }

    for (const hs of grouped.values()) {
      if (hs.length < 6) continue // 少頭数は組み合わせが偏るため除外
      const venueCode = String(hs[0].venueCode)
      const raceNumber = Number(hs[0].raceNumber)
      const payouts = hjcRaces.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)?.payouts
      if (!payouts) continue

      // 我々の勝率(JRDB指数)と市場の勝率(最終単勝オッズ)
      const ourWin = softmaxProbabilities(
        hs.map((h) => num(h.overallIndex)),
        SOFTMAX_TEMPERATURE,
      )
      const finalOdds = hs.map((h) => {
        const t = tybMap.get(`${venueCode}-${raceNumber}-${num(h.umaban)}`)
        return t ? num(t.finalOdds) : 0
      })
      if (finalOdds.some((o) => o <= 0)) continue
      const rawMkt = finalOdds.map((o) => 1 / o)
      const mktSum = rawMkt.reduce((s, v) => s + v, 0)
      const mktWin = rawMkt.map((v) => v / mktSum)

      const sortedOur = [...ourWin].sort((a, b) => b - a)
      const indexGap = (sortedOur[0] - (sortedOur[1] ?? 0)) * 100

      // 馬単位の情報(血統モデルの学習用)。払戻は複勝を使う(血統の「儲かりやすさ」の基準として)
      const meta = hs.map((h) => {
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(h.umaban),
        )
        const ukc = ukcByKetto.get(str(h.kettoNumber))
        const sire = ukc ? str(ukc.sireName) : ''
        const trackCode = sed ? num(sed.trackCode) : 0
        const distance = sed ? num(sed.distance) : 0
        const going = sed ? num(sed.trackCondition) : 0
        return {
          umaban: num(h.umaban),
          sire,
          surfaceKey: sire && trackCode ? `${sire}|${trackCode}` : '',
          goingKey: sire && going ? `${sire}|${going}` : '',
          distKey: sire && distance ? `${sire}|${distanceBucket(distance)}` : '',
          fukusho: sed ? num(sed.fukushoPayout) : 0,
          ok: !!sed && !!sire && !!trackCode && !!distance,
        }
      })
      if (meta.some((m) => !m.ok)) continue
      for (const m of meta) {
        horses.push({ fold, sire: m.sire, surfaceKey: m.surfaceKey, goingKey: m.goingKey, distKey: m.distKey, payout: m.fukusho })
      }

      // 的中した組み合わせ(HJCの確定配当から取得)
      const umarenHit = new Map<string, number>()
      for (const e of payouts.umaren) umarenHit.set(comboKey(e.combo[0], e.combo[1]), e.payoutYen)
      const wideHit = new Map<string, number>()
      for (const e of payouts.wide) wideHit.set(comboKey(e.combo[0], e.combo[1]), e.payoutYen)

      for (let i = 0; i < hs.length; i++) {
        for (let j = i + 1; j < hs.length; j++) {
          // 馬連: 我々の確率と市場の確率を同じHarville法で算出して比較する
          const ourQ = quinellaProbability(ourWin[i], ourWin[j])
          const mktQ = quinellaProbability(mktWin[i], mktWin[j])
          const ourW = wideProbability(i, j, ourWin)
          const mktW = wideProbability(i, j, mktWin)
          // 馬連・ワイドそれぞれのエッジは近い値になるため、馬連のエッジを代表値として使う
          const edge = (ourQ - mktQ) * 100
          if (edge < 0.5) continue // ごく小さいエッジは対象外(点数が膨大になるため)

          const k = comboKey(meta[i].umaban, meta[j].umaban)
          bets.push({
            fold,
            edge,
            indexGap,
            umarenWin: umarenHit.has(k),
            umarenPayout: umarenHit.get(k) ?? 0,
            wideWin: wideHit.has(k),
            widePayout: wideHit.get(k) ?? 0,
            sireA: meta[i].sire,
            surfA: meta[i].surfaceKey,
            goingA: meta[i].goingKey,
            distA: meta[i].distKey,
            sireB: meta[j].sire,
            surfB: meta[j].surfaceKey,
            goingB: meta[j].goingKey,
            distB: meta[j].distKey,
          })
          void ourW
          void mktW
        }
      }
    }
    processed++
    if (processed % 200 === 0) console.log(`  ...${processed}/${dates.length}日 (買い目${bets.length.toLocaleString()}点)`)
  }
  return { bets, horses }
}

// 血統モデル(複勝の回収率で学習、4層)
function buildModel(train: HorseRow[]) {
  const globalMean = train.length > 0 ? (train.reduce((s, r) => s + r.payout, 0) / (train.length * 100)) * 100 : 0
  const predicted = new Array(train.length).fill(globalMean)
  const layers: { key: keyof HorseRow; shrink: number }[] = [
    { key: 'sire', shrink: SHRINK.sire },
    { key: 'surfaceKey', shrink: SHRINK.surface },
    { key: 'goingKey', shrink: SHRINK.going },
    { key: 'distKey', shrink: SHRINK.distance },
  ]
  const tables: Map<string, number>[] = []
  for (const layer of layers) {
    const resid = new Map<string, { sum: number; n: number }>()
    for (let i = 0; i < train.length; i++) {
      const k = train[i][layer.key] as string
      if (!k) continue
      const cur = resid.get(k) ?? { sum: 0, n: 0 }
      cur.sum += train[i].payout - predicted[i]
      cur.n += 1
      resid.set(k, cur)
    }
    const effect = new Map<string, number>()
    for (const [k, { sum, n }] of resid) effect.set(k, (sum / n) * (n / (n + layer.shrink)))
    tables.push(effect)
    for (let i = 0; i < train.length; i++) {
      const k = train[i][layer.key] as string
      if (k) predicted[i] += effect.get(k) ?? 0
    }
  }
  return (sire: string, surf: string, going: string, dist: string): number => {
    let v = globalMean
    const keys = [sire, surf, going, dist]
    keys.forEach((k, idx) => {
      if (k) v += tables[idx].get(k) ?? 0
    })
    return v
  }
}

type Counter = { bets: number; wins: number; payout: number }
const newCounter = (): Counter => ({ bets: 0, wins: 0, payout: 0 })
const roiOf = (c: Counter) => (c.bets > 0 ? (c.payout / (c.bets * 100)) * 100 : 0)
function fmt(c: Counter) {
  const hit = c.bets > 0 ? ((c.wins / c.bets) * 100).toFixed(1) : '0'
  return `試行${String(c.bets).padStart(7)}\t的中率${hit}%\t回収率${roiOf(c).toFixed(1)}%`
}

async function main() {
  console.log('=== 馬連・ワイドへの展開 ===')
  console.log('市場の組み合わせ確率は最終単勝オッズ(TYB)からHarville法で導出\n')

  const { bets, horses } = await collect()
  console.log(`\n買い目候補: ${bets.length.toLocaleString()}点 / 学習用の馬: ${horses.length.toLocaleString()}頭\n`)

  const edges = [1, 2, 3, 5]
  const variants = [
    { name: 'エッジのみ', ped: false, gap: 0 },
    { name: '+ 血統上位30%', ped: true, gap: 0 },
    { name: '+ 指数gap>=12', ped: false, gap: 12 },
    { name: '+ 血統30% + gap>=12', ped: true, gap: 12 },
  ]

  const umaren = new Map<string, Counter>()
  const wide = new Map<string, Counter>()
  const umarenFold = new Map<string, Counter[]>()
  const wideFold = new Map<string, Counter[]>()
  for (const e of edges) for (const v of variants) {
    umaren.set(`${e}|${v.name}`, newCounter())
    wide.set(`${e}|${v.name}`, newCounter())
    umarenFold.set(`${e}|${v.name}`, [])
    wideFold.set(`${e}|${v.name}`, [])
  }

  for (let testFold = 1; testFold < FOLDS; testFold++) {
    const trainHorses = horses.filter((h) => h.fold < testFold)
    const testBets = bets.filter((b) => b.fold === testFold)
    if (trainHorses.length === 0 || testBets.length === 0) continue
    const score = buildModel(trainHorses)

    const scored = testBets.map((b) => ({
      b,
      s: (score(b.sireA, b.surfA, b.goingA, b.distA) + score(b.sireB, b.surfB, b.goingB, b.distB)) / 2,
    }))
    const sortedS = scored.map((x) => x.s).sort((a, b) => a - b)
    const cut30 = sortedS[Math.floor(sortedS.length * 0.7)]

    for (const e of edges) {
      for (const v of variants) {
        const uc = newCounter()
        const wc = newCounter()
        for (const { b, s } of scored) {
          if (b.edge < e) continue
          if (v.ped && s < cut30) continue
          if (b.indexGap < v.gap) continue
          uc.bets += 1
          if (b.umarenWin) uc.wins += 1
          uc.payout += b.umarenPayout
          wc.bets += 1
          if (b.wideWin) wc.wins += 1
          wc.payout += b.widePayout
        }
        const ua = umaren.get(`${e}|${v.name}`)!
        ua.bets += uc.bets
        ua.wins += uc.wins
        ua.payout += uc.payout
        const wa = wide.get(`${e}|${v.name}`)!
        wa.bets += wc.bets
        wa.wins += wc.wins
        wa.payout += wc.payout
        umarenFold.get(`${e}|${v.name}`)!.push(uc)
        wideFold.get(`${e}|${v.name}`)!.push(wc)
      }
    }
  }

  for (const [label, store, foldStore] of [
    ['馬連', umaren, umarenFold],
    ['ワイド', wide, wideFold],
  ] as const) {
    console.log(`\n================ ${label} ================`)
    for (const e of edges) {
      console.log(`\n【エッジ+${e}pt以上】`)
      for (const v of variants) {
        const c = store.get(`${e}|${v.name}`)!
        const detail = foldStore
          .get(`${e}|${v.name}`)!
          .map((f) => (f.bets > 0 ? `${roiOf(f).toFixed(0)}%` : '-'))
          .join('/')
        console.log(`  ${v.name.padEnd(20)}\t${fmt(c)}\tfold別: ${detail}`)
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
