// SKBのパドックコメント(自由記述の日本語)に含まれる語彙ごとに、複勝回収率を集計する。
//
// 目的は2段階:
//   1) どの表現が儲かる馬を示すのかを知る
//   2) その情報を、発走15分前に入手できるTYBのパドック指数が既に捉えているかを確認する
//
// SKBは配信が約1週間遅れるため、コメント自体は馬券に使えない。
// しかしTYBのパドック指数が同じ情報を持っているなら、そちらを通じて実戦で活用できる。
// 実行: npx tsx scripts/jrdb-paddock-vocabulary.ts
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseSedBuffer, parseSkbBuffer, parseTybBuffer, jrdbFileDate } from '../server/jrdbParser'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// 実データのパドックコメントで頻出する表現を、意味のまとまりごとに分類する
const VOCAB: { group: string; word: string }[] = [
  // 仕上がり
  { group: '仕上がり', word: '仕上がる' },
  { group: '仕上がり', word: '仕上がり良' },
  { group: '仕上がり', word: '好仕上' },
  { group: '仕上がり', word: '一追い欲しい' },
  { group: '仕上がり', word: '未完成' },
  // 調子の方向
  { group: '調子', word: 'デキ上向' },
  { group: '調子', word: '上向' },
  { group: '調子', word: '平行線' },
  { group: '調子', word: '下降' },
  { group: '調子', word: '維持' },
  // 体つき
  { group: '体つき', word: '太い' },
  { group: '体つき', word: '余裕' },
  { group: '体つき', word: '絞れ' },
  { group: '体つき', word: '細い' },
  { group: '体つき', word: '腹袋' },
  { group: '体つき', word: '好馬体' },
  // 気配・精神面
  { group: '気配', word: '煩い' },
  { group: '気配', word: '落ち着' },
  { group: '気配', word: '気合' },
  { group: '気配', word: 'イレ込' },
  { group: '気配', word: 'ボンヤリ' },
  { group: '気配', word: '集中' },
  // 歩様
  { group: '歩様', word: '頭高' },
  { group: '歩様', word: '腰' },
  { group: '歩様', word: '硬い' },
  { group: '歩様', word: '柔らか' },
  { group: '歩様', word: '力強' },
  { group: '歩様', word: '歩様良' },
  // ローテーション
  { group: 'ローテ', word: '連闘' },
  { group: 'ローテ', word: '久々' },
  { group: 'ローテ', word: '休み明け' },
]

type Counter = { bets: number; wins: number; payout: number; paddockIndexSum: number; paddockIndexCount: number }
const newCounter = (): Counter => ({ bets: 0, wins: 0, payout: 0, paddockIndexSum: 0, paddockIndexCount: 0 })
const roiOf = (c: Counter) => (c.bets > 0 ? (c.payout / (c.bets * 100)) * 100 : 0)

async function main() {
  console.log('=== パドックコメントの語彙ごとの複勝回収率 ===\n')

  const dir = path.join(DATA_DIR, 'Skb')
  let skbFiles: string[]
  try {
    skbFiles = (await fs.readdir(dir)).filter((f) => /^SKB\d{6}\.txt$/.test(f))
  } catch {
    console.log('SKBがまだダウンロードされていません。')
    return
  }
  const dates = skbFiles
    .map((f) => {
      const m = f.match(/^SKB(\d{2})(\d{2})(\d{2})\.txt$/)!
      return jrdbFileDate(m[1], m[2], m[3])
    })
    .sort((a, b) => a.getTime() - b.getTime())

  console.log(`対象: ${dates.length}日分のSKB\n`)

  const overall = newCounter()
  const byWord = new Map<string, Counter>(VOCAB.map((v) => [v.word, newCounter()]))
  let processed = 0
  let withTyb = 0

  for (const date of dates) {
    const d8 = toYymmdd(date)
    let skbBuf: Buffer
    let sedBuf: Buffer
    try {
      skbBuf = await fs.readFile(path.join(DATA_DIR, 'Skb', `SKB${d8}.txt`))
      sedBuf = await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${d8}.txt`))
    } catch {
      continue
    }
    // TYBのパドック指数(発走15分前に入手可能)との対応も見る
    let tybMap: Map<string, number> | null = null
    try {
      const tybRows = parseTybBuffer(await fs.readFile(path.join(DATA_DIR, 'Tyb', `TYB${d8}.txt`)))
      tybMap = new Map(tybRows.map((t) => [`${t.venueCode}-${t.raceNumber}-${t.umaban}`, num(t.paddockIndex)]))
    } catch {
      // TYBが無い日はパドック指数の対応づけをスキップ
    }

    const skbRows = parseSkbBuffer(skbBuf)
    const sedRows = parseSedBuffer(sedBuf)

    for (const s of skbRows) {
      const venueCode = str(s.venueCode)
      const raceNumber = num(s.raceNumber)
      const umaban = num(s.umaban)
      const sed = sedRows.find(
        (r) => r.venueCode === venueCode && r.raceNumber === raceNumber && r.umaban === umaban,
      )
      if (!sed) continue
      const comment = str(s.paddockComment)
      if (!comment) continue

      const win = num(sed.fukushoPayout) > 0
      const payout = num(sed.fukushoPayout)
      const pIndex = tybMap?.get(`${venueCode}-${raceNumber}-${umaban}`)

      const record = (c: Counter) => {
        c.bets += 1
        if (win) c.wins += 1
        c.payout += payout
        if (pIndex !== undefined && pIndex > 0) {
          c.paddockIndexSum += pIndex
          c.paddockIndexCount += 1
        }
      }
      record(overall)
      if (pIndex !== undefined && pIndex > 0) withTyb++

      for (const v of VOCAB) {
        if (comment.includes(v.word)) record(byWord.get(v.word)!)
      }
    }
    processed++
    if (processed % 200 === 0) console.log(`  ...${processed}/${dates.length}日`)
  }

  console.log(`\n全体: 試行${overall.bets.toLocaleString()} 複勝的中率${((overall.wins / overall.bets) * 100).toFixed(1)}% 回収率${roiOf(overall).toFixed(1)}%`)
  console.log(`TYBのパドック指数が対応づけできた件数: ${withTyb.toLocaleString()}\n`)

  const base = roiOf(overall)
  const avgPIndex = overall.paddockIndexCount > 0 ? overall.paddockIndexSum / overall.paddockIndexCount : 0

  // グループごとに、出現数が一定以上の語だけを回収率順で表示する
  const groups = [...new Set(VOCAB.map((v) => v.group))]
  for (const g of groups) {
    console.log(`【${g}】`)
    const items = VOCAB.filter((v) => v.group === g)
      .map((v) => ({ word: v.word, c: byWord.get(v.word)! }))
      .filter((x) => x.c.bets >= 500)
      .sort((a, b) => roiOf(b.c) - roiOf(a.c))
    if (items.length === 0) {
      console.log('  (出現数500件未満のため対象外)\n')
      continue
    }
    for (const { word, c } of items) {
      const diff = roiOf(c) - base
      const pIdx = c.paddockIndexCount > 0 ? c.paddockIndexSum / c.paddockIndexCount : 0
      const pDiff = pIdx - avgPIndex
      console.log(
        `  ${word.padEnd(10)}\t出現${String(c.bets).padStart(6)}\t的中率${((c.wins / c.bets) * 100).toFixed(1)}%\t回収率${roiOf(c).toFixed(1)}%\t(全体比${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pt)\tパドック指数${pIdx.toFixed(2)}(${pDiff >= 0 ? '+' : ''}${pDiff.toFixed(2)})`,
      )
    }
    console.log('')
  }

  console.log('【見方】')
  console.log('  回収率の全体比がプラスの語=その表現が出る馬は市場に過小評価されている')
  console.log('  パドック指数の差が同じ向きに動いていれば、TYBの指数が同じ情報を捉えていることになる')
  console.log('  (TYBの指数は発走15分前に入手できるため、そちらは実戦で使える)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
