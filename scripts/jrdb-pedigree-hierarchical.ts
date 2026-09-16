// 血統の複数の切り口を、統計的に正しく同時に使う【階層モデル】。
//
// これまでの失敗: 「父馬×馬場」と「父馬×距離帯」を両方満たす馬に絞る(=フィルタの重ね掛け)方式は、
// 条件を掛け合わせるほどサンプルが分散して壊れる。実際に試して全パターン悪化した(5.2節)。
//
// 正しい組み合わせ方: 各切り口を「全体平均からのズレ(効果量)」として足し合わせる。
//   血統スコア = 全体平均
//              + 父馬の効果        (その父馬の出走数で縮小)
//              + 父馬×馬場の効果   (上位層で説明できない残りのズレだけを、その組の出走数で縮小)
//              + 父馬×馬場状態の効果
//              + 父馬×距離帯の効果
//              + ...
// 各層は「上位層で説明済みのぶんを引いた残差」に対して経験ベイズ縮小をかけるため、
// データが薄い組み合わせは自動的に上位層の推定へ寄る。サンプルを分散させずに多切り口を統合できる。
//
// 評価は5分割ウォークフォワード。学習期間でスコアを作り、テスト期間(未来)の実回収率を測る。
// 実行: npx tsx scripts/jrdb-pedigree-hierarchical.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseKyiBuffer, parseSedBuffer, parseUkcBuffer, jrdbFileDate, type UkcRow } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const FOLDS = 5
// 各層の縮小の強さ。回収率は配当の分散が大きいため強めに縮める。
// 下位層(細かい条件)ほどサンプルが薄いので、より強く上位層へ寄せる。
const SHRINK = { sire: 80, surface: 120, going: 150, distance: 150, sex: 150, klass: 150 }

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
// 馬齢(早熟/晩成の分析用)。生年月日と開催日から算出する。
function ageOf(birthDate: string, raceDate: Date): number {
  if (birthDate.length !== 8) return 0
  const by = Number(birthDate.slice(0, 4))
  if (!by) return 0
  return raceDate.getFullYear() - by
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

// 1頭ぶんの「血統スコアを作るのに必要な情報」と結果
type Row = {
  fold: number
  sire: string
  surfaceKey: string // 父×芝ダ
  goingKey: string // 父×馬場状態
  distKey: string // 父×距離帯
  sexKey: string // 父×性別
  classKey: string // 父×クラス
  ageKey: string // 父×馬齢
  damSireSurfaceKey: string // 母父×芝ダ
  win: boolean
  payout: number
}

type Counter = { bets: number; payout: number }
const newCounter = (): Counter => ({ bets: 0, payout: 0 })

async function collectRows(): Promise<{ rows: Row[]; dates: number }> {
  const dates = await listDates()
  const foldSize = Math.floor(dates.length / FOLDS)
  const foldOf = new Map<string, number>()
  dates.forEach((d, i) => foldOf.set(toYymmdd(d), Math.min(Math.floor(i / foldSize), FOLDS - 1)))

  const rows: Row[] = []
  let processed = 0

  for (const date of dates) {
    const d8 = toYymmdd(date)
    const fold = foldOf.get(d8)!
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

      const trackCode = num(sed.trackCode)
      const going = num(sed.trackCondition)
      const distance = num(sed.distance)
      const sex = num(ukc.sexCode)
      const klass = num(h.classCode)
      const age = ageOf(str(ukc.birthDate), date)
      const damSire = str(ukc.damSireName)
      if (!trackCode || !distance) continue

      rows.push({
        fold,
        sire,
        surfaceKey: `${sire}|${trackCode}`,
        goingKey: going ? `${sire}|${going}` : '',
        distKey: `${sire}|${distanceBucket(distance)}`,
        sexKey: sex ? `${sire}|${sex}` : '',
        classKey: klass ? `${sire}|${klass}` : '',
        ageKey: age ? `${sire}|${Math.min(age, 7)}` : '', // 7歳以上はまとめる
        damSireSurfaceKey: damSire ? `${damSire}|${trackCode}` : '',
        win: num(sed.tanshoPayout) > 0,
        payout: num(sed.tanshoPayout),
      })
    }

    processed++
    if (processed % 300 === 0) console.log(`  ...${processed}/${dates.length}日 (${rows.length.toLocaleString()}頭)`)
  }
  return { rows, dates: dates.length }
}

// 階層モデル: 上位層で説明できなかった残差に対してのみ、下位層の効果を推定する
type Layer = { name: string; key: keyof Row; shrink: number }

function buildModel(train: Row[], layers: Layer[]) {
  const globalMean = train.length > 0 ? train.reduce((s, r) => s + r.payout, 0) / (train.length * 100) * 100 : 0

  // 各行の「現時点の予測値」。層を進むごとに更新していく
  const predicted = new Array(train.length).fill(globalMean)
  const tables: Map<string, Map<string, number>> = new Map()

  for (const layer of layers) {
    // 残差(実績 - 現時点の予測)をキーごとに集計
    const resid = new Map<string, { sum: number; n: number }>()
    for (let i = 0; i < train.length; i++) {
      const k = train[i][layer.key] as string
      if (!k) continue
      const actual = (train[i].payout / 100) * 100
      const cur = resid.get(k) ?? { sum: 0, n: 0 }
      cur.sum += actual - predicted[i]
      cur.n += 1
      resid.set(k, cur)
    }
    // 経験ベイズ縮小: サンプルが少ないキーの効果は0(=上位層のまま)に寄せる
    const effect = new Map<string, number>()
    for (const [k, { sum, n }] of resid) {
      effect.set(k, (sum / n) * (n / (n + layer.shrink)))
    }
    tables.set(layer.name, effect)
    // 予測値を更新
    for (let i = 0; i < train.length; i++) {
      const k = train[i][layer.key] as string
      if (!k) continue
      predicted[i] += effect.get(k) ?? 0
    }
  }

  const score = (r: Row): number => {
    let v = globalMean
    for (const layer of layers) {
      const k = r[layer.key] as string
      if (!k) continue
      v += tables.get(layer.name)!.get(k) ?? 0
    }
    return v
  }
  return { score, globalMean }
}

function report(label: string, buckets: Counter[]) {
  const labels = ['最低20%', '下位20-40%', '中位40-60%', '上位60-80%', '最高20%']
  console.log(`【${label}】`)
  for (let i = 0; i < 5; i++) {
    const b = buckets[i]
    const roi = b.bets > 0 ? (b.payout / (b.bets * 100)) * 100 : 0
    console.log(`  ${labels[i].padEnd(10)} → 回収率 ${roi.toFixed(1)}%\t(試行${b.bets.toLocaleString()})`)
  }
  const top = buckets[4].bets > 0 ? (buckets[4].payout / (buckets[4].bets * 100)) * 100 : 0
  const bottom = buckets[0].bets > 0 ? (buckets[0].payout / (buckets[0].bets * 100)) * 100 : 0
  console.log(`  → 差: ${(top - bottom).toFixed(1)}pt\n`)
  return top
}

// 指定の層構成でウォークフォワード評価する
function evaluate(rows: Row[], layers: Layer[], label: string, extraTop?: number[]) {
  const buckets = Array.from({ length: 5 }, newCounter)
  const topN: Map<number, Counter> = new Map((extraTop ?? []).map((p) => [p, newCounter()]))

  for (let testFold = 1; testFold < FOLDS; testFold++) {
    const train = rows.filter((r) => r.fold < testFold)
    const test = rows.filter((r) => r.fold === testFold)
    if (train.length === 0 || test.length === 0) continue

    const { score } = buildModel(train, layers)
    const scored = test.map((r) => ({ r, s: score(r) }))
    const sorted = [...scored].sort((a, b) => a.s - b.s)
    const cuts = [0.2, 0.4, 0.6, 0.8].map((p) => sorted[Math.floor(sorted.length * p)].s)

    for (const { r, s } of scored) {
      let b = 0
      while (b < 4 && s >= cuts[b]) b++
      buckets[b].bets += 1
      buckets[b].payout += r.payout
    }
    // 上位N%も測る(絞り込むほど良くなるかの確認)
    for (const p of extraTop ?? []) {
      const cut = sorted[Math.floor(sorted.length * (1 - p / 100))].s
      for (const { r, s } of scored) {
        if (s < cut) continue
        const c = topN.get(p)!
        c.bets += 1
        c.payout += r.payout
      }
    }
  }

  const top = report(label, buckets)
  for (const p of extraTop ?? []) {
    const c = topN.get(p)!
    const roi = c.bets > 0 ? (c.payout / (c.bets * 100)) * 100 : 0
    console.log(`  上位${p}%のみ → 回収率 ${roi.toFixed(1)}%\t(試行${c.bets.toLocaleString()})`)
  }
  if (extraTop?.length) console.log('')
  return top
}

async function main() {
  console.log('=== 血統の複数切り口を階層モデルで統合する ===\n')
  const { rows, dates } = await collectRows()
  console.log(`\n対象: ${rows.length.toLocaleString()}頭 / ${dates}日\n`)

  const ALL: Layer[] = [
    { name: '父馬', key: 'sire', shrink: SHRINK.sire },
    { name: '父×馬場', key: 'surfaceKey', shrink: SHRINK.surface },
    { name: '父×馬場状態', key: 'goingKey', shrink: SHRINK.going },
    { name: '父×距離帯', key: 'distKey', shrink: SHRINK.distance },
    { name: '父×性別', key: 'sexKey', shrink: SHRINK.sex },
    { name: '父×クラス', key: 'classKey', shrink: SHRINK.klass },
    { name: '父×馬齢', key: 'ageKey', shrink: SHRINK.klass },
    { name: '母父×馬場', key: 'damSireSurfaceKey', shrink: SHRINK.surface },
  ]

  console.log('=== 比較: 単層(父馬のみ) vs 多層(全切り口) ===\n')
  evaluate(rows, [ALL[0]], '父馬のみ(単層)')
  evaluate(rows, ALL.slice(0, 2), '父馬 + 父×馬場')
  evaluate(rows, ALL.slice(0, 4), '父馬 + 馬場 + 馬場状態 + 距離帯(4層)', [10, 5, 2, 1])
  evaluate(rows, ALL, '全8層(性別・クラス・馬齢・母父×馬場も追加)', [10, 5, 2, 1])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
