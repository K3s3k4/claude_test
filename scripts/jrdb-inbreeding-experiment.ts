// インブリード(血統クロス)が回収率と相関するかを検証する。
//
// 「祖先を個別の特徴量にする」方式は種類が爆発してサンプルが分散し、
// 系統コード・複合キーの検証で2度失敗している。そこで血統を
// 「同一祖先が系図の複数箇所に現れるか(クロス)」という少数のパターンに圧縮して扱う。
//
// インブリードは系図から直接計算できる構造的特徴であり、過去成績から学習する必要がないため
// リークの心配はない。ただし一貫性確認のため、他の検証と同じ5分割ウォークフォワードで評価する。
// 実行: npx tsx scripts/jrdb-inbreeding-experiment.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { softmaxProbabilities } from '../server/probability'
import { parseKyiBuffer, parseSedBuffer, parseUkcBuffer, jrdbFileDate, type KyiRow, type UkcRow } from '../server/jrdbParser'
import { buildAncestors, summarizeInbreeding, type PedigreeIndex } from '../server/pedigree'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const SOFTMAX_TEMPERATURE = 8
const EDGE_THRESHOLD = 0.08
const MAX_GEN = 5

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// 全UKCから2種類の索引を1度だけ作る。
//   byName:  馬名 -> 父・母・母父 (祖先を辿るチェーン用)
//   byKetto: 血統登録番号 -> 父・母・母父 (出走馬から血統を引く用)
// 日別にUKCを読み直すとI/Oとメモリを浪費するため、最初にまとめて構築する。
async function buildPedigreeIndexes(): Promise<{ byName: PedigreeIndex; byKetto: PedigreeIndex }> {
  const dir = path.join(DATA_DIR, 'Ukc')
  const files = (await fs.readdir(dir)).filter((f) => /^UKC\d{6}\.txt$/.test(f))
  const byName: PedigreeIndex = new Map()
  const byKetto: PedigreeIndex = new Map()
  for (const f of files) {
    let rows: UkcRow[]
    try {
      rows = parseUkcBuffer(await fs.readFile(path.join(dir, f)))
    } catch {
      continue
    }
    for (const r of rows) {
      const ped = { sire: str(r.sireName), dam: str(r.damName), damSire: str(r.damSireName) }
      const name = str(r.horseName)
      if (name) byName.set(name, ped)
      const ketto = str(r.kettoNumber)
      if (ketto) byKetto.set(ketto, ped)
    }
  }
  return { byName, byKetto }
}

async function listKyiDates(): Promise<Date[]> {
  const dir = path.join(DATA_DIR, 'Kyi')
  const files = await fs.readdir(dir)
  const dates: Date[] = []
  for (const f of files) {
    const m = f.match(/^KYI(\d{2})(\d{2})(\d{2})\.txt$/)
    if (!m) continue
    dates.push(jrdbFileDate(m[1], m[2], m[3]))
  }
  return dates.sort((a, b) => a.getTime() - b.getTime())
}

type EdgeBet = {
  raceKey: string
  win: boolean
  payout: number
  hasCross: boolean
  hasCloseCross: boolean
  coefficient: number
  topCrossAncestor: string
  knownGen3Plus: number // 3世代目以降で判明した祖先数(系図の充実度)
}

async function collectEdgeBets(index: PedigreeIndex): Promise<EdgeBet[]> {
  const dates = (await listKyiDates()).filter((d) => d < new Date())
  const bets: EdgeBet[] = []

  for (const date of dates) {
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
      const ukcRows = parseUkcBuffer(await fs.readFile(path.join(DATA_DIR, 'Ukc', `UKC${dateStr8}.txt`)))
      ukcByKetto = new Map(ukcRows.map((r) => [str(r.kettoNumber), r]))
    } catch {
      continue // 血統が引けない日は対象外
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
        if (ourProbs[i] - marketProbs[i] < EDGE_THRESHOLD) continue
        const sed = sedRows.find(
          (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === num(horses[i].umaban),
        )
        if (!sed) continue
        const ukc = ukcByKetto.get(str(horses[i].kettoNumber))
        if (!ukc) continue

        const root = { sire: str(ukc.sireName), dam: str(ukc.damName), damSire: str(ukc.damSireName) }
        const ancestors = buildAncestors(root, index, MAX_GEN)
        const s = summarizeInbreeding(ancestors)

        bets.push({
          raceKey: `${dateStr8}-${key}`,
          win: num(sed.tanshoPayout) > 0,
          payout: num(sed.tanshoPayout),
          hasCross: s.crossCount > 0,
          hasCloseCross: s.hasCloseCross,
          coefficient: s.coefficient,
          topCrossAncestor: s.topCross?.ancestor ?? '',
          knownGen3Plus: ancestors.filter((a) => a.generation >= 3).length,
        })
      }
    }
  }
  return bets
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
  console.log('=== インブリード(血統クロス)と回収率の関係を検証 ===')
  console.log('対象: 単勝バリューベット(エッジ+8pt以上)\n')

  const index = await buildPedigreeIndex()
  console.log(`血統索引: ${index.size.toLocaleString()}頭\n`)

  const allBets = await collectEdgeBets(index)
  console.log(`エッジ条件を満たすベット総数: ${allBets.length}件`)
  const crossRate = allBets.filter((b) => b.hasCross).length / allBets.length
  console.log(`うちクロス検出: ${allBets.filter((b) => b.hasCross).length}件 (${(crossRate * 100).toFixed(1)}%)\n`)

  const conditions: { name: string; filter: (b: EdgeBet) => boolean }[] = [
    { name: 'フィルタなし', filter: () => true },
    { name: 'クロスあり', filter: (b) => b.hasCross },
    { name: 'クロスなし', filter: (b) => !b.hasCross },
    { name: '濃いクロスあり(3世代以内に2回)', filter: (b) => b.hasCloseCross },
    { name: '近交係数>=0.5%', filter: (b) => b.coefficient >= 0.005 },
    { name: '近交係数>=1.0%', filter: (b) => b.coefficient >= 0.01 },
    { name: 'サンデーサイレンスのクロス', filter: (b) => b.topCrossAncestor === 'サンデーサイレンス' },
  ]

  const raceKeys = [...new Set(allBets.map((b) => b.raceKey))].sort()
  const FOLDS = 5
  const foldSize = Math.floor(raceKeys.length / FOLDS)

  console.log('=== 5分割した期間ごとの一貫性確認 ===\n')
  const aggregate = new Map<string, EdgeBet[]>()
  for (const c of conditions) aggregate.set(c.name, [])

  for (let fold = 1; fold < FOLDS; fold++) {
    const testStart = foldSize * fold
    const testEnd = fold === FOLDS - 1 ? raceKeys.length : foldSize * (fold + 1)
    const foldKeys = new Set(raceKeys.slice(testStart, testEnd))
    const foldBets = allBets.filter((b) => foldKeys.has(b.raceKey))

    console.log(`--- fold${fold}(${foldBets.length}件) ---`)
    for (const c of conditions) {
      const filtered = foldBets.filter(c.filter)
      console.log(`  ${c.name}\t${fmt(filtered)}`)
      aggregate.get(c.name)!.push(...filtered)
    }
    console.log('')
  }

  console.log('=== 全fold合算 ===')
  for (const c of conditions) {
    console.log(`${c.name}\t${fmt(aggregate.get(c.name)!)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
