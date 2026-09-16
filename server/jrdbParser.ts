import fs from 'node:fs/promises'
import path from 'node:path'
import iconv from 'iconv-lite'
import {
  softmaxProbabilities,
  placeProbability,
  quinellaProbability,
  wideProbability,
  exactaProbability,
  trioSetProbability,
  trifectaOrderProbability,
} from './probability'
import { confidenceScore, combinationsIdx, permutationsIdx } from './predict'
import { allocateRaceStakes, DEFAULT_BUDGET_YEN } from './stake'

const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')
const RECORD_LENGTH = 1024 // JRDB KYI/SEDは1レコード1024バイト固定長(末尾2バイトはCRLF)

// JRA競馬場コード(JRDB・netkeiba共通の業界標準コード表)
export const VENUE_NAMES: Record<string, string> = {
  '01': '札幌',
  '02': '函館',
  '03': '福島',
  '04': '新潟',
  '05': '東京',
  '06': '中山',
  '07': '中京',
  '08': '京都',
  '09': '阪神',
  '10': '小倉',
}
export const VENUE_CODE_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(VENUE_NAMES).map(([code, name]) => [name, code]),
)

type FieldKind = 'int' | 'float1' | 'str' | 'hex'
type FieldSpec = [name: string, start1: number, len: number, kind: FieldKind]

// KYI(競走馬データ)の主要項目。相対位置(1始まり)・バイト数は JRDB公式仕様書(kyi_doc.txt, 第11版)に準拠。
// 全項目ではなく、予想に使えそうな指数・識別項目を中心に抜粋している。
const KYI_FIELDS: FieldSpec[] = [
  ['venueCode', 1, 2, 'str'],
  ['year', 3, 2, 'str'],
  ['kaiji', 5, 1, 'int'],
  ['dayHex', 6, 1, 'hex'],
  ['raceNumber', 7, 2, 'int'],
  ['umaban', 9, 2, 'int'],
  ['kettoNumber', 11, 8, 'str'],
  ['horseName', 19, 36, 'str'],
  ['idm', 55, 5, 'float1'],
  ['jockeyIndex', 60, 5, 'float1'],
  ['infoIndex', 65, 5, 'float1'],
  ['overallIndex', 85, 5, 'float1'],
  ['runningStyleCode', 90, 1, 'int'],
  ['distanceAptCode', 91, 1, 'int'],
  ['risingDegree', 92, 1, 'int'],
  ['baseOdds', 96, 5, 'float1'],
  ['basePopularity', 101, 2, 'int'],
  ['basePlaceOdds', 103, 5, 'float1'],
  ['basePlacePopularity', 108, 2, 'int'],
  ['popularityIndex', 140, 5, 'int'],
  ['trainingIndex', 145, 5, 'float1'],
  ['stableIndex', 150, 5, 'float1'],
  ['jockeyWinPlaceRate', 157, 4, 'float1'],
  ['explosiveIndex', 161, 3, 'int'],
  ['classCode', 167, 2, 'int'],
  ['jockeyName', 172, 12, 'str'],
  ['weightCarriedRaw', 184, 3, 'int'], // 0.1kg単位
  ['trainerName', 188, 12, 'str'],
  ['trainerAffiliation', 200, 4, 'str'],
  ['waku', 324, 1, 'int'], // 枠番(1-8)
  ['turfAptCode', 334, 1, 'str'],
  ['dirtAptCode', 335, 1, 'str'],
  ['jockeyCode', 336, 5, 'str'],
  ['trainerCode', 341, 5, 'str'],
  ['tenIndex', 359, 5, 'float1'], // テン指数(展開予想)
  ['paceIndex', 364, 5, 'float1'],
  ['agariIndex', 369, 5, 'float1'],
  ['positionIndex', 374, 5, 'float1'],
  ['paceForecast', 379, 1, 'str'], // H/M/S

  // --- 以下、JRDB公式仕様書(kyi_doc.txt)に存在するが未使用だった項目を追加 ---
  // 状態・変わり身の判断材料
  ['trainingArrowCode', 155, 1, 'int'], // 調教矢印(上昇/平行/下降)
  ['stableEvalCode', 156, 1, 'int'], // 厩舎評価
  ['hoofCode', 164, 2, 'int'], // 蹄コード
  ['mudAptCode', 166, 1, 'int'], // 重適性(道悪適性)
  ['blinker', 171, 1, 'str'], // 1:初装着, 2:再装着, 3:ブリンカー
  ['sexCode', 404, 1, 'int'], // 1:牡, 2:牝, 3:セン
  ['horseSymbolCode', 447, 2, 'int'], // 馬記号(地方馬・外国産馬など)
  ['confirmedWeight', 397, 3, 'int'], // 枠確定馬体重
  ['confirmedWeightDiffRaw', 400, 3, 'str'], // 符号+数字2桁
  ['cancelFlag', 403, 1, 'int'], // 1:取消

  // 穴馬の発見用(JRDB独自)
  ['jackpotIndex', 535, 3, 'int'], // 万券指数
  ['jackpotMark', 538, 1, 'int'], // 万券印
  ['explosiveRank', 449, 2, 'int'], // 激走順位(レース内)
  ['explosiveType', 540, 2, 'str'], // 激走タイプ

  // クラス・ローテーション
  ['demotionFlag', 539, 1, 'int'], // 1:降級, 2:2段階降級, 0:通常
  ['restReasonCode', 542, 2, 'int'], // 休養理由分類
  ['runsSinceStabling', 560, 2, 'int'], // 入厩何走目
  ['daysSinceStabling', 570, 3, 'int'], // 入厩何日前
  ['pastureRank', 623, 1, 'str'], // 放牧先ランク A-E
  ['stableRank', 624, 1, 'int'], // 厩舎ランク 1(高)-9(低)

  // 騎手の期待値(JRDB算出)
  ['jockeyExpectedWinRate', 461, 4, 'float1'],
  ['jockeyExpectedTop3Rate', 465, 4, 'float1'],

  // レース内での各指数の順位
  ['lsIndexRank', 451, 2, 'int'],
  ['tenIndexRank', 453, 2, 'int'],
  ['paceIndexRank', 455, 2, 'int'],
  ['agariIndexRank', 457, 2, 'int'],
  ['positionIndexRank', 459, 2, 'int'],
]

function decodeField(buf: Buffer, start1: number, len: number, kind: FieldKind): string | number | null {
  const slice = buf.subarray(start1 - 1, start1 - 1 + len)
  if (kind === 'str') {
    const text = iconv.decode(slice, 'Shift_JIS').trim()
    return text.length > 0 ? text : null
  }
  const raw = slice.toString('latin1').trim()
  if (raw.length === 0) return null
  if (kind === 'hex') return raw
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

export type KyiRow = Record<string, string | number | null>

export function parseKyiBuffer(buf: Buffer): KyiRow[] {
  const rows: KyiRow[] = []
  for (let offset = 0; offset + RECORD_LENGTH <= buf.length; offset += RECORD_LENGTH) {
    const record = buf.subarray(offset, offset + RECORD_LENGTH)
    const row: KyiRow = {}
    for (const [name, start1, len, kind] of KYI_FIELDS) {
      row[name] = decodeField(record, start1, len, kind)
    }
    rows.push(row)
  }
  return rows
}

// SED(成績データ)は1レコード376バイト固定長。JRDB公式仕様書(sed_doc.txt, 第4版a)に準拠。
const SED_RECORD_LENGTH = 376
const SED_FIELDS: FieldSpec[] = [
  ['venueCode', 1, 2, 'str'],
  ['year', 3, 2, 'str'],
  ['kaiji', 5, 1, 'int'],
  ['dayHex', 6, 1, 'hex'],
  ['raceNumber', 7, 2, 'int'],
  ['umaban', 9, 2, 'int'],
  ['horseName', 27, 36, 'str'],
  ['distance', 63, 4, 'int'],
  ['trackCode', 67, 1, 'int'], // 1:芝, 2:ダート, 3:障害
  ['trackCondition', 70, 2, 'int'],
  ['gradeCode', 80, 1, 'int'], // 1:G1, 2:G2, 3:G3 (それ以外は非重賞)
  ['raceName', 81, 50, 'str'],
  ['headCount', 131, 2, 'int'],
  ['raceNameShort', 133, 8, 'str'],
  ['finishPosition', 141, 2, 'int'],
  ['abnormalCode', 143, 1, 'int'], // 0:正常, それ以外:出走取消/中止等
  ['timeRaw', 144, 4, 'str'], // 先頭1桁=分, 残り3桁=秒(0.1秒単位)
  ['weightCarried', 148, 3, 'int'], // 0.1kg単位
  ['jockeyName', 151, 12, 'str'],
  ['trainerName', 163, 12, 'str'],
  ['confirmedOdds', 175, 6, 'float1'],
  ['confirmedPopularity', 181, 2, 'int'],
  ['idmActual', 183, 3, 'int'],
  ['rawScore', 186, 3, 'int'],
  ['horseWeight', 333, 3, 'int'],
  ['horseWeightDiffRaw', 336, 3, 'str'], // 符号+数字2桁
  ['tanshoPayout', 342, 7, 'int'],
  ['fukushoPayout', 349, 7, 'int'],
]

export type SedRow = Record<string, string | number | null>

export function parseSedBuffer(buf: Buffer): SedRow[] {
  const rows: SedRow[] = []
  for (let offset = 0; offset + SED_RECORD_LENGTH <= buf.length; offset += SED_RECORD_LENGTH) {
    const record = buf.subarray(offset, offset + SED_RECORD_LENGTH)
    const row: SedRow = {}
    for (const [name, start1, len, kind] of SED_FIELDS) {
      row[name] = decodeField(record, start1, len, kind)
    }
    // タイム(先頭1桁=分, 残り3桁=0.1秒単位の秒)を秒数に変換して追加
    const timeRaw = String(row.timeRaw ?? '').trim()
    if (timeRaw.length === 4) {
      const minutes = Number(timeRaw[0])
      const secondsTenths = Number(timeRaw.slice(1))
      if (!Number.isNaN(minutes) && !Number.isNaN(secondsTenths)) {
        row.timeSeconds = Math.round((minutes * 60 + secondsTenths / 10) * 10) / 10
      }
    }
    rows.push(row)
  }
  return rows
}

// UKC(馬基本データ)は1レコード292バイト固定長。血統(父馬名・母馬名・母父馬名・系統コード)を含む。
// JRDB公式仕様書(ukc_doc.txt, 第3版)に準拠。血統登録番号(kettoNumber)でKYI/SEDと結合できる。
const UKC_RECORD_LENGTH = 292
const UKC_FIELDS: FieldSpec[] = [
  ['kettoNumber', 1, 8, 'str'],
  ['horseName', 9, 36, 'str'],
  ['sexCode', 45, 1, 'int'], // 1:牡, 2:牝, 3:セン
  ['sireName', 50, 36, 'str'],
  ['damName', 86, 36, 'str'],
  ['damSireName', 122, 36, 'str'],
  ['sireKeitoCode', 277, 4, 'int'], // 父系統コード(前2桁:大系統, 後2桁:小系統)
  ['damSireKeitoCode', 281, 4, 'int'], // 母父系統コード
]

export type UkcRow = Record<string, string | number | null>

export function parseUkcBuffer(buf: Buffer): UkcRow[] {
  const rows: UkcRow[] = []
  for (let offset = 0; offset + UKC_RECORD_LENGTH <= buf.length; offset += UKC_RECORD_LENGTH) {
    const record = buf.subarray(offset, offset + UKC_RECORD_LENGTH)
    const row: UkcRow = {}
    for (const [name, start1, len, kind] of UKC_FIELDS) {
      row[name] = decodeField(record, start1, len, kind)
    }
    rows.push(row)
  }
  return rows
}

// TYB(直前情報データ)は1レコード128バイト固定長。JRDB公式仕様書(tyb_doc.txt, 第4b版)に準拠。
// 発走約15分前に作成されるため、KYIの「前日の基準オッズ」と違い、実質的な最終オッズを持つ。
// 当日でないと分からない馬体重・馬場状態・気配もここに入る。
const TYB_RECORD_LENGTH = 128
const TYB_FIELDS: FieldSpec[] = [
  ['venueCode', 1, 2, 'str'],
  ['year', 3, 2, 'str'],
  ['kaiji', 5, 1, 'int'],
  ['dayHex', 6, 1, 'hex'],
  ['raceNumber', 7, 2, 'int'],
  ['umaban', 9, 2, 'int'],
  ['idm', 11, 5, 'float1'],
  ['jockeyIndex', 16, 5, 'float1'],
  ['infoIndex', 21, 5, 'float1'],
  ['oddsIndex', 26, 5, 'float1'],
  ['paddockIndex', 31, 5, 'float1'],
  ['overallIndex', 41, 5, 'float1'],
  ['equipmentChange', 46, 1, 'int'], // 0:なし 1:変更 2:特注(効果が期待される変更)
  ['legInfo', 47, 1, 'int'], // 0:平行 1:良化 2:疑問 3:悪化
  ['cancelFlag', 48, 1, 'int'],
  ['jockeyCode', 49, 5, 'str'],
  ['jockeyName', 54, 12, 'str'],
  ['weightCarriedRaw', 66, 3, 'int'], // 0.1kg単位
  ['apprenticeClass', 69, 1, 'int'],
  ['trackConditionCode', 70, 2, 'int'], // 当日の馬場状態
  ['weatherCode', 72, 1, 'int'],
  ['finalOdds', 73, 6, 'float1'], // 単勝オッズ(直前情報作成時点)
  ['finalPlaceOdds', 79, 6, 'float1'], // 複勝オッズ(下側)
  ['oddsTime', 85, 4, 'int'], // HHMM
  ['horseWeight', 89, 3, 'int'],
  ['horseWeightDiffRaw', 92, 3, 'str'], // 符号+数字2桁
  ['oddsMark', 95, 1, 'str'],
  ['paddockMark', 96, 1, 'str'],
  ['finalOverallMark', 97, 1, 'str'],
  ['bodyCode', 98, 1, 'str'], // 馬体コード
  ['conditionCode', 99, 1, 'str'], // 気配コード
  ['startTime', 100, 4, 'int'], // HHMM
]

export type TybRow = Record<string, string | number | null>

export function parseTybBuffer(buf: Buffer): TybRow[] {
  const rows: TybRow[] = []
  for (let offset = 0; offset + TYB_RECORD_LENGTH <= buf.length; offset += TYB_RECORD_LENGTH) {
    const record = buf.subarray(offset, offset + TYB_RECORD_LENGTH)
    const row: TybRow = {}
    for (const [name, start1, len, kind] of TYB_FIELDS) {
      row[name] = decodeField(record, start1, len, kind)
    }
    rows.push(row)
  }
  return rows
}

function toYymmddLocal(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

// 指定日のSEDファイルから、venue・raceNumberで絞り込んだ結果一覧を返す。
// まだ結果が確定していない(SED未ダウンロード)場合は null。
export async function getSedRace(
  date: Date,
  venue: string,
  raceNumber: number,
): Promise<{ horses: SedRow[] } | null> {
  const dateStr = toYymmddLocal(date)
  const filePath = path.join(DATA_DIR, 'Sed', `SED${dateStr}.txt`)

  let buf: Buffer
  try {
    buf = await fs.readFile(filePath)
  } catch {
    return null
  }

  const venueCode = VENUE_CODE_BY_NAME[venue] ?? venue
  const rows = parseSedBuffer(buf)
  const horses = rows.filter((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)
  if (horses.length === 0) return null
  return { horses: horses.sort((a, b) => (Number(a.finishPosition) || 999) - (Number(b.finishPosition) || 999)) }
}

// HJC(払戻情報データ)は1レコード444バイト、レース単位(馬ごとではない)。
// JRDB公式仕様書(hjcdata_doc.txt, 第4a版)に準拠。
const HJC_RECORD_LENGTH = 444

export type HjcPayoutEntry = { combo: number[]; payoutYen: number }
export type HjcRacePayouts = {
  tansho: HjcPayoutEntry[]
  fukusho: HjcPayoutEntry[]
  umaren: HjcPayoutEntry[]
  wide: HjcPayoutEntry[]
  umatan: HjcPayoutEntry[]
  sanrenpuku: HjcPayoutEntry[]
  sanrentan: HjcPayoutEntry[]
}

function readIntAt(buf: Buffer, start1: number, len: number): number | null {
  const raw = buf.subarray(start1 - 1, start1 - 1 + len).toString('latin1').trim()
  if (raw.length === 0) return null
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

// 馬番組合せは「馬番(digitsPerHorse桁)をhorsesPerCombo頭分並べた数字」として格納されている。
// 例: umaren "0611" → digitsPerHorse=2 → [6, 11]
function decodeComboDigits(raw: number | null, digitsPerHorse: number, horsesPerCombo: number): number[] {
  if (raw == null) return []
  const s = String(raw).padStart(digitsPerHorse * horsesPerCombo, '0')
  const nums: number[] = []
  for (let i = 0; i < horsesPerCombo; i++) {
    const part = Number(s.slice(i * digitsPerHorse, (i + 1) * digitsPerHorse))
    if (part > 0) nums.push(part)
  }
  return nums
}

function readRepeatingPayouts(
  buf: Buffer,
  start1: number,
  occ: number,
  comboBytes: number,
  payoutBytes: number,
  digitsPerHorse: number,
  horsesPerCombo: number,
): HjcPayoutEntry[] {
  const entries: HjcPayoutEntry[] = []
  let offset = start1
  for (let i = 0; i < occ; i++) {
    const comboRaw = readIntAt(buf, offset, comboBytes)
    const payout = readIntAt(buf, offset + comboBytes, payoutBytes)
    if (payout != null && payout > 0) {
      const combo = decodeComboDigits(comboRaw, digitsPerHorse, horsesPerCombo)
      if (combo.length === horsesPerCombo) entries.push({ combo, payoutYen: payout })
    }
    offset += comboBytes + payoutBytes
  }
  return entries
}

export function parseHjcBuffer(buf: Buffer): { venueCode: string; raceNumber: number; payouts: HjcRacePayouts }[] {
  const races: { venueCode: string; raceNumber: number; payouts: HjcRacePayouts }[] = []
  for (let offset = 0; offset + HJC_RECORD_LENGTH <= buf.length; offset += HJC_RECORD_LENGTH) {
    const record = buf.subarray(offset, offset + HJC_RECORD_LENGTH)
    const venueCode = record.subarray(0, 2).toString('latin1')
    const raceNumber = readIntAt(record, 7, 2) ?? 0

    races.push({
      venueCode,
      raceNumber,
      payouts: {
        tansho: readRepeatingPayouts(record, 9, 3, 2, 7, 2, 1),
        fukusho: readRepeatingPayouts(record, 36, 5, 2, 7, 2, 1),
        umaren: readRepeatingPayouts(record, 108, 3, 4, 8, 2, 2),
        wide: readRepeatingPayouts(record, 144, 7, 4, 8, 2, 2),
        umatan: readRepeatingPayouts(record, 228, 6, 4, 8, 2, 2),
        sanrenpuku: readRepeatingPayouts(record, 300, 3, 6, 8, 2, 3),
        sanrentan: readRepeatingPayouts(record, 342, 6, 6, 9, 2, 3),
      },
    })
  }
  return races
}

// 指定日のHJCファイルから、venue・raceNumberで絞り込んだ全券種の払戻を返す。未ダウンロードならnull。
export async function getHjcRace(date: Date, venue: string, raceNumber: number): Promise<HjcRacePayouts | null> {
  const dateStr = toYymmddLocal(date)
  const filePath = path.join(DATA_DIR, 'Hjc', `HJC${dateStr}.txt`)

  let buf: Buffer
  try {
    buf = await fs.readFile(filePath)
  } catch {
    return null
  }

  const venueCode = VENUE_CODE_BY_NAME[venue] ?? venue
  const races = parseHjcBuffer(buf)
  const race = races.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)
  return race?.payouts ?? null
}

function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

// 指定日のKYIファイルを読み、venue(場名 or 場コード)・raceNumberで絞り込んだ出走馬一覧を返す。
// ローカルにダウンロード済みでなければ null を返す。
export async function getKyiRace(
  date: Date,
  venue: string,
  raceNumber: number,
): Promise<{ venueName: string; raceNumber: number; horses: KyiRow[] } | null> {
  const dateStr = toYymmdd(date)
  const filePath = path.join(DATA_DIR, 'Kyi', `KYI${dateStr}.txt`)

  let buf: Buffer
  try {
    buf = await fs.readFile(filePath)
  } catch {
    return null // 未ダウンロード
  }

  const venueCode = VENUE_CODE_BY_NAME[venue] ?? venue
  const rows = parseKyiBuffer(buf)
  const horses = rows.filter((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)
  if (horses.length === 0) return null

  return { venueName: VENUE_NAMES[venueCode] ?? venueCode, raceNumber, horses }
}

// softmax(総合指数)による1位-2位の推定勝率差から、確度ラベルのみを軽量に算出する。
// (analyzeJrdbRace()と同じ閾値・同じ算出方法。一覧表示のボタン色分け用に文章生成なしで使う。)
function quickConfidenceLabel(horses: KyiRow[]): '堅い' | 'やや堅い' | '混戦' {
  const scores = horses.map((h) => Number(h.overallIndex) || 0)
  const winProbs = [...softmaxProbabilities(scores, JRDB_SOFTMAX_TEMPERATURE)].sort((a, b) => b - a)
  const gap = Math.round(((winProbs[0] ?? 0) - (winProbs[1] ?? 0)) * 1000) / 10
  return jrdbConfidenceLabel(gap)
}

// 指定日のKYIファイルに含まれる開催場・レース番号の一覧(重複除去)。UIでの選択肢表示用。
// 各レースの確度ラベル(堅い/やや堅い/混戦)も付与する。
export async function listKyiRaces(
  date: Date,
): Promise<{ venueCode: string; venueName: string; raceNumber: number; confidenceLabel: '堅い' | 'やや堅い' | '混戦' }[]> {
  const dateStr = toYymmdd(date)
  const filePath = path.join(DATA_DIR, 'Kyi', `KYI${dateStr}.txt`)

  let buf: Buffer
  try {
    buf = await fs.readFile(filePath)
  } catch {
    return []
  }

  const rows = parseKyiBuffer(buf)
  const grouped = new Map<string, { venueCode: string; venueName: string; raceNumber: number; horses: KyiRow[] }>()
  for (const r of rows) {
    const venueCode = String(r.venueCode)
    const raceNumber = Number(r.raceNumber)
    const key = `${venueCode}-${raceNumber}`
    if (!grouped.has(key)) {
      grouped.set(key, { venueCode, venueName: VENUE_NAMES[venueCode] ?? venueCode, raceNumber, horses: [] })
    }
    grouped.get(key)!.horses.push(r)
  }
  return [...grouped.values()]
    .map((g) => ({
      venueCode: g.venueCode,
      venueName: g.venueName,
      raceNumber: g.raceNumber,
      confidenceLabel: quickConfidenceLabel(g.horses),
    }))
    .sort((a, b) => a.venueCode.localeCompare(b.venueCode) || a.raceNumber - b.raceNumber)
}

// --- 分析(/predictと同じ手法: softmaxで推定勝率化、probabilityGapから確度スコア、ファクトベースの分析文) ---

// バックテスト(scripts/jrdb-calibration-check.ts)により、10407レースのアーカイブ全体で
// 予測勝率と実際の勝率のズレが最小(全帯域で誤差2pt未満)になる値として8をキャリブレーション済み。
const JRDB_SOFTMAX_TEMPERATURE = 8

const JRDB_FACTOR_LABELS: Record<string, string> = {
  idm: 'IDM',
  jockeyIndex: '騎手指数',
  infoIndex: '情報指数',
  trainingIndex: '調教指数',
  stableIndex: '厩舎指数',
}

function jrdbConfidenceLabel(gap: number): '堅い' | 'やや堅い' | '混戦' {
  if (gap >= 12) return '堅い'
  if (gap >= 6) return 'やや堅い'
  return '混戦'
}

export type JrdbAnalyzedHorse = KyiRow & { winProbability: number; placeProbability: number }
export type JrdbRaceAnalysis = {
  confidenceScore: number
  confidenceLabel: '堅い' | 'やや堅い' | '混戦'
  probabilityGap: number
  topPickSummary: string // 本命馬のファクトベース分析文
  leadSummary: string // レース全体のサマリ(リード文)
  horses: JrdbAnalyzedHorse[]
  bets: JrdbBetSuggestions | null
}

// KYIの総合指数(JRDB独自の総合評価値)をscoreHorse()の合成スコアの代わりに使い、
// /predictと同じsoftmax→確度スコア→ファクトベース分析文の手法をJRDBデータにも適用する。
export function analyzeJrdbRace(venueName: string, raceNumber: number, horses: KyiRow[]): JrdbRaceAnalysis | null {
  if (horses.length === 0) return null

  const scores = horses.map((h) => Number(h.overallIndex) || 0)
  const winProbs = softmaxProbabilities(scores, JRDB_SOFTMAX_TEMPERATURE)

  const analyzed: JrdbAnalyzedHorse[] = horses.map((h, i) => ({
    ...h,
    winProbability: winProbs[i],
    placeProbability: placeProbability(i, winProbs),
  }))

  const ranked = [...analyzed].sort((a, b) => b.winProbability - a.winProbability)
  const gap = Math.round((ranked[0].winProbability - (ranked[1]?.winProbability ?? 0)) * 1000) / 10
  const score = confidenceScore(gap)
  const label = jrdbConfidenceLabel(gap)

  const top = ranked[0]
  const second = ranked[1]
  const third = ranked[2]

  const factorKeys = Object.keys(JRDB_FACTOR_LABELS)
  const rankOf = (key: string, horse: JrdbAnalyzedHorse): number => {
    const values = analyzed.map((h) => Number(h[key as keyof JrdbAnalyzedHorse]) || -Infinity)
    const sortedDesc = [...values].sort((a, b) => b - a)
    return sortedDesc.indexOf(Number(horse[key as keyof JrdbAnalyzedHorse]) || -Infinity) + 1
  }
  const factorRanks = factorKeys.map((key) => ({ key, rank: rankOf(key, top) }))
  const strengths = factorRanks.filter((f) => f.rank <= 3).sort((a, b) => a.rank - b.rank)
  const weaknesses = factorRanks.filter((f) => f.rank > analyzed.length / 2).sort((a, b) => b.rank - a.rank)

  const topParts: string[] = []
  topParts.push(
    `${top.horseName}(${top.umaban}番)は総合指数${top.overallIndex}で本命評価、推定勝率${(top.winProbability * 100).toFixed(1)}%。`,
  )
  if (strengths.length > 0) {
    topParts.push(
      `${strengths.map((s) => `${JRDB_FACTOR_LABELS[s.key]}(全${analyzed.length}頭中${s.rank}位)`).join('・')}が高評価の要因。`,
    )
  }
  if (weaknesses.length > 0) {
    topParts.push(`一方${weaknesses.map((w) => `${JRDB_FACTOR_LABELS[w.key]}(${w.rank}位)`).join('・')}は見劣りする。`)
  }
  const topPickSummary = topParts.join('')

  const leadParts: string[] = []
  leadParts.push(
    `${venueName}${raceNumber}Rは、総合指数トップの${top.horseName}(${top.umaban}番・推定勝率${(top.winProbability * 100).toFixed(1)}%)を本命に、`,
  )
  if (second) leadParts.push(`${second.horseName}(${second.umaban}番)`)
  if (third) leadParts.push(`、${third.horseName}(${third.umaban}番)が続く${label === '混戦' ? '混戦模様' : `${label}レース`}。`)
  if (label === '堅い') leadParts.push(`本命・対抗の推定勝率差は${gap}ptと大きく、上位人気決着が濃厚。`)
  else if (label === '混戦') leadParts.push(`本命・対抗の推定勝率差は${gap}ptとわずかで、上位が拮抗した混戦模様。`)
  else leadParts.push(`本命・対抗の推定勝率差は${gap}pt。`)
  const leadSummary = leadParts.join('')

  const bets = suggestJrdbBets(ranked, label)

  return { confidenceScore: score, confidenceLabel: label, probabilityGap: gap, topPickSummary, leadSummary, horses: analyzed, bets }
}

// --- 買い目・購入額(/predictの推奨買い目・予算配分ロジックと同じ手法) ---

type Pick = { umaban: number; name: string }
type Combo = { picks: Pick[]; probability: number; stakeYen: number }

export type JrdbBetSuggestions = {
  boxSize: number
  tansho: { pick: Pick; winProbability: number; stakeYen: number }[]
  fukusho: { pick: Pick; placeProbability: number; stakeYen: number }[]
  umaren: Combo[]
  wide: Combo[]
  umatan: Combo[]
  sanrenpuku: Combo[]
  sanrentan: Combo[]
  totalStakeYen: number
}

const TOP_N_PER_BET_TYPE = 3
function topNCombos(combos: { picks: Pick[]; probability: number }[]) {
  return combos.slice(0, TOP_N_PER_BET_TYPE)
}
function byProbDesc(a: { probability: number }, b: { probability: number }) {
  return b.probability - a.probability
}

function suggestJrdbBets(
  ranked: JrdbAnalyzedHorse[],
  confidence: '堅い' | 'やや堅い' | '混戦',
  budget: number = DEFAULT_BUDGET_YEN,
): JrdbBetSuggestions | null {
  if (ranked.length < 3) return null

  const toPick = (h: JrdbAnalyzedHorse): Pick => ({ umaban: Number(h.umaban), name: String(h.horseName) })
  const allWinProbs = ranked.map((h) => h.winProbability)

  let boxSize = confidence === '堅い' ? 3 : confidence === 'やや堅い' ? 4 : 5
  boxSize = Math.min(boxSize, ranked.length)

  const boxIdx = Array.from({ length: boxSize }, (_, i) => i)
  const axisIdx = boxIdx[0]
  const flowIdx = boxIdx.slice(1)

  const umaren = topNCombos(
    combinationsIdx(boxSize, 2)
      .map((pair) => {
        const [i, j] = pair.map((k) => boxIdx[k])
        return { picks: [toPick(ranked[i]), toPick(ranked[j])], probability: quinellaProbability(allWinProbs[i], allWinProbs[j]) }
      })
      .sort(byProbDesc),
  )
  const wide = topNCombos(
    combinationsIdx(boxSize, 2)
      .map((pair) => {
        const [i, j] = pair.map((k) => boxIdx[k])
        return { picks: [toPick(ranked[i]), toPick(ranked[j])], probability: wideProbability(i, j, allWinProbs) }
      })
      .sort(byProbDesc),
  )
  const sanrenpuku =
    boxSize >= 3
      ? topNCombos(
          combinationsIdx(boxSize, 3)
            .map((trio) => {
              const [i, j, k] = trio.map((x) => boxIdx[x])
              return {
                picks: [toPick(ranked[i]), toPick(ranked[j]), toPick(ranked[k])],
                probability: trioSetProbability(allWinProbs[i], allWinProbs[j], allWinProbs[k]),
              }
            })
            .sort(byProbDesc),
        )
      : []
  const umatan = topNCombos(
    flowIdx
      .map((j) => ({
        picks: [toPick(ranked[axisIdx]), toPick(ranked[j])],
        probability: exactaProbability(allWinProbs[axisIdx], allWinProbs[j]),
      }))
      .sort(byProbDesc),
  )
  const sanrentan =
    flowIdx.length >= 2
      ? topNCombos(
          permutationsIdx(flowIdx, 2)
            .map(([j, k]) => ({
              picks: [toPick(ranked[axisIdx]), toPick(ranked[j]), toPick(ranked[k])],
              probability: trifectaOrderProbability(allWinProbs[axisIdx], allWinProbs[j], allWinProbs[k]),
            }))
            .sort(byProbDesc),
        )
      : []

  const tansho = [{ pick: toPick(ranked[0]), winProbability: ranked[0].winProbability }]
  const fukusho = ranked.slice(0, Math.min(3, boxSize)).map((h) => ({ pick: toPick(h), placeProbability: h.placeProbability }))

  const stakesByType = allocateRaceStakes(
    {
      tansho: tansho.map((t) => ({ probability: t.winProbability })),
      fukusho: fukusho.map((f) => ({ probability: f.placeProbability })),
      umaren: umaren.map((c) => ({ probability: c.probability })),
      wide: wide.map((c) => ({ probability: c.probability })),
      umatan: umatan.map((c) => ({ probability: c.probability })),
      sanrenpuku: sanrenpuku.map((c) => ({ probability: c.probability })),
      sanrentan: sanrentan.map((c) => ({ probability: c.probability })),
    },
    budget,
  )

  const withStake = <T extends { probability: number }>(arr: T[], type: string): (T & { stakeYen: number })[] =>
    arr.map((c, i) => ({ ...c, stakeYen: stakesByType[type]?.[i] ?? 0 }))

  const tanshoWithStake = tansho.map((t, i) => ({ ...t, stakeYen: stakesByType.tansho?.[i] ?? 0 }))
  const fukushoWithStake = fukusho.map((f, i) => ({ ...f, stakeYen: stakesByType.fukusho?.[i] ?? 0 }))

  const totalStakeYen = Object.values(stakesByType)
    .flat()
    .reduce((s, v) => s + v, 0)

  return {
    boxSize,
    tansho: tanshoWithStake,
    fukusho: fukushoWithStake,
    umaren: withStake(umaren, 'umaren'),
    wide: withStake(wide, 'wide'),
    umatan: withStake(umatan, 'umatan'),
    sanrenpuku: withStake(sanrenpuku, 'sanrenpuku'),
    sanrentan: withStake(sanrentan, 'sanrentan'),
    totalStakeYen,
  }
}

// --- 結果(SED)との突き合わせ ---

// グレードコード(SED)。1:G1, 2:G2, 3:G3, 5:Listed。それ以外(重賞でない/OP等)はnullを返す。
export function gradeLabel(code: number | null): string | null {
  if (code === 1) return 'G1'
  if (code === 2) return 'G2'
  if (code === 3) return 'G3'
  if (code === 5) return 'L'
  return null
}

export type JrdbRaceMeta = { raceName: string | null; gradeLabel: string | null; headCount: number | null }

// SEDの先頭行からレース名・グレード・頭数を取り出す(同一レース内は全行で同じ値)。
export function getJrdbRaceMeta(sedHorses: SedRow[]): JrdbRaceMeta {
  const first = sedHorses[0]
  if (!first) return { raceName: null, gradeLabel: null, headCount: null }
  return {
    raceName: first.raceName ? String(first.raceName) : null,
    gradeLabel: gradeLabel(typeof first.gradeCode === 'number' ? first.gradeCode : null),
    headCount: typeof first.headCount === 'number' ? first.headCount : null,
  }
}

export type JrdbActualBet = { picks: Pick[]; stakeYen: number; hit: boolean; payoutYen: number }
export type JrdbActualReturn = {
  tansho: JrdbActualBet[]
  fukusho: JrdbActualBet[]
  umaren: JrdbActualBet[]
  wide: JrdbActualBet[]
  umatan: JrdbActualBet[]
  sanrenpuku: JrdbActualBet[]
  sanrentan: JrdbActualBet[]
  totalStakeYen: number
  totalPayoutYen: number
  returnRate: number | null
  note: string | null // HJC(配当データ)が未ダウンロードの場合、単勝・複勝のみでの集計である旨の注記
}

const JRDB_ORDERED_BET_TYPES = new Set(['umatan', 'sanrentan'])

function comboKey(umabans: number[], ordered: boolean): string {
  return (ordered ? umabans : [...umabans].sort((a, b) => a - b)).join(',')
}

// 提案した買い目を、SED(単勝・複勝払戻)とHJC(全券種の確定配当)と突き合わせて実際の収支を計算する。
// HJCが未ダウンロードの場合は、SEDに含まれる単勝・複勝のみで計算し、その旨を注記する。
export function computeJrdbActualReturn(bets: JrdbBetSuggestions, sedHorses: SedRow[], hjc: HjcRacePayouts | null): JrdbActualReturn {
  const sedTanshoByUmaban = new Map<number, number>()
  const sedFukushoByUmaban = new Map<number, number>()
  for (const h of sedHorses) {
    sedTanshoByUmaban.set(Number(h.umaban), Number(h.tanshoPayout) || 0)
    sedFukushoByUmaban.set(Number(h.umaban), Number(h.fukushoPayout) || 0)
  }

  function settleSingle(picks: { pick: Pick; stakeYen: number }[], payoutOf: (umaban: number) => number): JrdbActualBet[] {
    return picks.map((p) => {
      const payout = payoutOf(p.pick.umaban)
      return { picks: [p.pick], stakeYen: p.stakeYen, hit: payout > 0, payoutYen: payout > 0 ? Math.round((p.stakeYen / 100) * payout) : 0 }
    })
  }

  function settleCombo(combos: Combo[], entries: HjcPayoutEntry[], type: string): JrdbActualBet[] {
    const ordered = JRDB_ORDERED_BET_TYPES.has(type)
    const payoutByKey = new Map<string, number>()
    for (const e of entries) payoutByKey.set(comboKey(e.combo, ordered), e.payoutYen)
    return combos.map((c) => {
      const payout = payoutByKey.get(comboKey(c.picks.map((p) => p.umaban), ordered)) ?? 0
      return { picks: c.picks, stakeYen: c.stakeYen, hit: payout > 0, payoutYen: payout > 0 ? Math.round((c.stakeYen / 100) * payout) : 0 }
    })
  }

  const tanshoPayoutOf = hjc
    ? (umaban: number) => hjc.tansho.find((e) => e.combo[0] === umaban)?.payoutYen ?? 0
    : (umaban: number) => sedTanshoByUmaban.get(umaban) ?? 0
  const fukushoPayoutOf = hjc
    ? (umaban: number) => hjc.fukusho.find((e) => e.combo[0] === umaban)?.payoutYen ?? 0
    : (umaban: number) => sedFukushoByUmaban.get(umaban) ?? 0

  const tansho = settleSingle(bets.tansho, tanshoPayoutOf)
  const fukusho = settleSingle(bets.fukusho, fukushoPayoutOf)
  const umaren = hjc ? settleCombo(bets.umaren, hjc.umaren, 'umaren') : []
  const wide = hjc ? settleCombo(bets.wide, hjc.wide, 'wide') : []
  const umatan = hjc ? settleCombo(bets.umatan, hjc.umatan, 'umatan') : []
  const sanrenpuku = hjc ? settleCombo(bets.sanrenpuku, hjc.sanrenpuku, 'sanrenpuku') : []
  const sanrentan = hjc ? settleCombo(bets.sanrentan, hjc.sanrentan, 'sanrentan') : []

  const all = [...tansho, ...fukusho, ...umaren, ...wide, ...umatan, ...sanrenpuku, ...sanrentan]
  const totalStakeYen = all.reduce((s, b) => s + b.stakeYen, 0)
  const totalPayoutYen = all.reduce((s, b) => s + b.payoutYen, 0)

  return {
    tansho,
    fukusho,
    umaren,
    wide,
    umatan,
    sanrenpuku,
    sanrentan,
    totalStakeYen,
    totalPayoutYen,
    returnRate: totalStakeYen > 0 ? Math.round((totalPayoutYen / totalStakeYen) * 1000) / 10 : null,
    note: hjc ? null : '馬連・ワイド・馬単・三連複・三連単の配当データ(HJC)が未ダウンロードのため、単勝・複勝のみで集計しています。',
  }
}

// --- アーカイブ全体のスキャン(直近の自信がある買い目・検索可能なレース一覧・全期間バックテスト集計で共用) ---

// JRDBのファイル名は西暦下2桁(YYMMDD)のため、そのまま2000を足すと1999年が2099年になってしまう。
// JRDBのアーカイブは1999年開始なので、90以上は1900年代として扱う。
// (ファイル名を文字列のままソートすると "UKC99..." が "UKC26..." より後ろに来る問題も、
//  この関数でDateに変換してから比較することで回避できる)
export function jrdbFileDate(yy: string, mm: string, dd: string): Date {
  const year = Number(yy) >= 90 ? 1900 + Number(yy) : 2000 + Number(yy)
  return new Date(year, Number(mm) - 1, Number(dd))
}

// data/jrdb/Kyi 配下に存在する日付の一覧(ダウンロード済みの日のみ)を新しい順で返す。
async function listAvailableKyiDates(): Promise<Date[]> {
  const dir = path.join(DATA_DIR, 'Kyi')
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const dates: Date[] = []
  for (const f of files) {
    const m = f.match(/^KYI(\d{2})(\d{2})(\d{2})\.txt$/)
    if (!m) continue
    const [, yy, mm, dd] = m
    dates.push(jrdbFileDate(yy, mm, dd))
  }
  return dates.sort((a, b) => b.getTime() - a.getTime())
}

function isoDateOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export type JrdbRaceRecord = {
  raceKey: string // "yymmdd-venueCode-raceNumber"
  raceDate: string // YYYY-MM-DD
  venueCode: string
  venueName: string
  raceNumber: number
  raceName: string | null
  gradeLabel: string | null
  confidence: '堅い' | 'やや堅い' | '混戦'
  confidenceScore: number
  topPickSummary: string
  completed: boolean
  totalStakeYen: number | null
  totalPayoutYen: number | null
  returnRate: number | null
}

// 1日ぶんのKYI(+あればSED/HJC)を読み込み、その日の全レースを分析・実績照合してレコード化する。
async function scanJrdbRaceDay(date: Date): Promise<JrdbRaceRecord[]> {
  const dateStr8 = toYymmdd(date)
  const kyiPath = path.join(DATA_DIR, 'Kyi', `KYI${dateStr8}.txt`)

  let kyiBuf: Buffer
  try {
    kyiBuf = await fs.readFile(kyiPath)
  } catch {
    return []
  }

  const kyiRows = parseKyiBuffer(kyiBuf)
  const grouped = new Map<string, { venueCode: string; raceNumber: number; horses: KyiRow[] }>()
  for (const r of kyiRows) {
    const venueCode = String(r.venueCode)
    const raceNumber = Number(r.raceNumber)
    const key = `${venueCode}-${raceNumber}`
    if (!grouped.has(key)) grouped.set(key, { venueCode, raceNumber, horses: [] })
    grouped.get(key)!.horses.push(r)
  }

  let sedRows: SedRow[] = []
  try {
    sedRows = parseSedBuffer(await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${dateStr8}.txt`)))
  } catch {
    // 未確定 or 未ダウンロード
  }
  let hjcRaces: ReturnType<typeof parseHjcBuffer> = []
  try {
    hjcRaces = parseHjcBuffer(await fs.readFile(path.join(DATA_DIR, 'Hjc', `HJC${dateStr8}.txt`)))
  } catch {
    // 未ダウンロード
  }

  const isoDate = isoDateOf(date)
  const records: JrdbRaceRecord[] = []

  for (const { venueCode, raceNumber, horses } of grouped.values()) {
    const venueName = VENUE_NAMES[venueCode] ?? venueCode
    const analysis = analyzeJrdbRace(venueName, raceNumber, horses)
    if (!analysis) continue

    const sedHorses = sedRows.filter((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)
    const meta = sedHorses.length > 0 ? getJrdbRaceMeta(sedHorses) : { raceName: null, gradeLabel: null, headCount: null }
    const hjcPayouts = hjcRaces.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)?.payouts ?? null
    const actualReturn =
      sedHorses.length > 0 && analysis.bets ? computeJrdbActualReturn(analysis.bets, sedHorses, hjcPayouts) : null

    records.push({
      raceKey: `${dateStr8}-${venueCode}-${raceNumber}`,
      raceDate: isoDate,
      venueCode,
      venueName,
      raceNumber,
      raceName: meta.raceName,
      gradeLabel: meta.gradeLabel,
      confidence: analysis.confidenceLabel,
      confidenceScore: analysis.confidenceScore,
      topPickSummary: analysis.topPickSummary,
      completed: sedHorses.length > 0,
      totalStakeYen: actualReturn?.totalStakeYen ?? null,
      totalPayoutYen: actualReturn?.totalPayoutYen ?? null,
      returnRate: actualReturn?.returnRate ?? null,
    })
  }
  return records
}

// 指定日数分(直近から遡って)のレースレコードをまとめて取得する。
// 同時に開くファイル数を抑えるため小分けのバッチで処理する(daysBackが大きい場合の急激なメモリ増加を防ぐ)。
async function scanJrdbRaceRange(daysBack: number): Promise<JrdbRaceRecord[]> {
  const dates = await listAvailableKyiDates()
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - daysBack)
  const targetDates = dates.filter((d) => d >= cutoff)

  const results: JrdbRaceRecord[][] = []
  for (let i = 0; i < targetDates.length; i += SCAN_CONCURRENCY) {
    const chunk = targetDates.slice(i, i + SCAN_CONCURRENCY)
    results.push(...(await Promise.all(chunk.map((d) => scanJrdbRaceDay(d)))))
  }
  return results.flat().sort((a, b) => (a.raceDate < b.raceDate ? 1 : a.raceDate > b.raceDate ? -1 : a.raceNumber - b.raceNumber))
}

export type JrdbRecentPick = JrdbRaceRecord & { bets: JrdbBetSuggestions | null }

// ダッシュボード表示用: 直近で入手できている開催日(未来の開催日が既に公開されていればそちらを優先)のうち、
// 確度スコア上位N件を返す。
export async function getJrdbRecentPicks(limit = 4): Promise<JrdbRecentPick[]> {
  const dates = await listAvailableKyiDates()
  if (dates.length === 0) return []

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const future = dates.filter((d) => d >= today).sort((a, b) => a.getTime() - b.getTime())
  const targetDate = future[0] ?? dates[0] // 未来開催日があれば直近のもの、無ければ最新の過去開催日

  const dateStr8 = toYymmdd(targetDate)
  const kyiPath = path.join(DATA_DIR, 'Kyi', `KYI${dateStr8}.txt`)
  let kyiBuf: Buffer
  try {
    kyiBuf = await fs.readFile(kyiPath)
  } catch {
    return []
  }
  const kyiRows = parseKyiBuffer(kyiBuf)
  const grouped = new Map<string, { venueCode: string; raceNumber: number; horses: KyiRow[] }>()
  for (const r of kyiRows) {
    const venueCode = String(r.venueCode)
    const raceNumber = Number(r.raceNumber)
    const key = `${venueCode}-${raceNumber}`
    if (!grouped.has(key)) grouped.set(key, { venueCode, raceNumber, horses: [] })
    grouped.get(key)!.horses.push(r)
  }

  const records = await scanJrdbRaceDay(targetDate)
  const withBets: JrdbRecentPick[] = records.map((r) => {
    const group = grouped.get(`${r.venueCode}-${r.raceNumber}`)!
    const analysis = analyzeJrdbRace(r.venueName, r.raceNumber, group.horses)
    return { ...r, bets: analysis?.bets ?? null }
  })

  return withBets.sort((a, b) => b.confidenceScore - a.confidenceScore).slice(0, limit)
}

export type JrdbBetTypeStats = {
  betType: string
  attempts: number
  hits: number
  hitRate: number
  totalStakeYen: number
  totalPayout: number
  returnRate: number
}
export type JrdbStatsSummary = {
  raceCount: number
  totalStakeYen: number
  totalPayout: number
  netYen: number
  returnRate: number
  byType: JrdbBetTypeStats[]
}

const JRDB_BET_TYPE_ORDER = ['tansho', 'fukusho', 'umaren', 'wide', 'umatan', 'sanrenpuku', 'sanrentan'] as const

// 全アーカイブスキャン(10年分・3万件超のレース)は、生ファイルの読み込み+全レース分の買い目計算を
// 毎回やり直すと非常に重く、Promise.allで全日付を同時に処理するとメモリも急増する
// (以前はキャッシュ温め処理が3回連続でフルスキャンを実行し、JSヒープ不足でサーバーがクラッシュした)。
// そこで「日付ごとの券種別集計」という小さい結果だけをディスクに永続化し、新しく追加された日付だけを
// 差分計算する方式に変更した。券種別の的中率・回収率の集計に必要な数値(試行数・的中数・賭け金・払戻額)
// さえ残せば十分なので、個々の買い目(picks配列など)は集計した時点で捨てる。
const BACKTEST_CACHE_TTL_MS = 10 * 60 * 1000
const backtestCache = new Map<string, { computedAt: number; result: JrdbStatsSummary }>()
const timeseriesCache = new Map<string, { computedAt: number; result: JrdbStatsPeriodPoint[] }>()

type RaceTypeAgg = { attempts: number; hits: number; stake: number; payout: number }
type RaceAggregateEntry = { period: string; confidence: string; byType: Partial<Record<(typeof JRDB_BET_TYPE_ORDER)[number], RaceTypeAgg>> }

function emptyAgg(): RaceTypeAgg {
  return { attempts: 0, hits: 0, stake: 0, payout: 0 }
}

const ANALYSIS_CACHE_PATH = path.join(DATA_DIR, '..', 'jrdb-analysis-cache.json')
const SCAN_CONCURRENCY = 16 // 同時に開くファイル数を抑え、メモリ・ファイルハンドルの急増を防ぐ

let sharedEntries: RaceAggregateEntry[] | null = null
let buildPromise: Promise<RaceAggregateEntry[]> | null = null

// 1日ぶんのKYI/SED/HJCを読み、その日の全レースを券種別カウンタに集計する(生の買い目配列は保持しない)。
async function scanOneDateAggregated(date: Date): Promise<RaceAggregateEntry[]> {
  const dateStr8 = toYymmdd(date)
  const kyiPath = path.join(DATA_DIR, 'Kyi', `KYI${dateStr8}.txt`)
  let kyiBuf: Buffer
  try {
    kyiBuf = await fs.readFile(kyiPath)
  } catch {
    return []
  }
  const kyiRows = parseKyiBuffer(kyiBuf)
  const grouped = new Map<string, { venueCode: string; raceNumber: number; horses: KyiRow[] }>()
  for (const r of kyiRows) {
    const venueCode = String(r.venueCode)
    const raceNumber = Number(r.raceNumber)
    const key = `${venueCode}-${raceNumber}`
    if (!grouped.has(key)) grouped.set(key, { venueCode, raceNumber, horses: [] })
    grouped.get(key)!.horses.push(r)
  }
  let sedRows: SedRow[] = []
  try {
    sedRows = parseSedBuffer(await fs.readFile(path.join(DATA_DIR, 'Sed', `SED${dateStr8}.txt`)))
  } catch {
    return [] // 結果未確定の日は集計対象外
  }
  let hjcRaces: ReturnType<typeof parseHjcBuffer> = []
  try {
    hjcRaces = parseHjcBuffer(await fs.readFile(path.join(DATA_DIR, 'Hjc', `HJC${dateStr8}.txt`)))
  } catch {
    // HJC未取得なら単勝・複勝のみで集計(computeJrdbActualReturnがフォールバック)
  }

  const period = isoDateOf(date)
  const out: RaceAggregateEntry[] = []
  for (const { venueCode, raceNumber, horses } of grouped.values()) {
    const venueName = VENUE_NAMES[venueCode] ?? venueCode
    const analysis = analyzeJrdbRace(venueName, raceNumber, horses)
    if (!analysis?.bets) continue
    const sedHorses = sedRows.filter((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)
    if (sedHorses.length === 0) continue
    const hjcPayouts = hjcRaces.find((r) => r.venueCode === venueCode && r.raceNumber === raceNumber)?.payouts ?? null
    const actualReturn = computeJrdbActualReturn(analysis.bets, sedHorses, hjcPayouts)

    const byType: RaceAggregateEntry['byType'] = {}
    for (const type of JRDB_BET_TYPE_ORDER) {
      const bets = actualReturn[type]
      if (bets.length === 0) continue
      const agg = emptyAgg()
      for (const b of bets) {
        agg.attempts += 1
        if (b.hit) agg.hits += 1
        agg.stake += b.stakeYen
        agg.payout += b.payoutYen
      }
      byType[type] = agg
    }
    out.push({ period, confidence: analysis.confidenceLabel, byType })
  }
  return out
}

// 日付リストを小分けのバッチで処理し、ピークメモリを抑える(全件Promise.allは避ける)。
async function scanDatesAggregated(dates: Date[]): Promise<RaceAggregateEntry[]> {
  const out: RaceAggregateEntry[] = []
  for (let i = 0; i < dates.length; i += SCAN_CONCURRENCY) {
    const chunk = dates.slice(i, i + SCAN_CONCURRENCY)
    const results = await Promise.all(chunk.map(scanOneDateAggregated))
    for (const r of results) out.push(...r)
  }
  return out
}

// 永続化キャッシュ(ディスク)を読み込み、まだ集計していない日付だけを差分計算して追記する。
// サーバー再起動をまたいでも、新規ダウンロード分の日付だけを計算すれば済むようになる。
// 複数箇所から同時に呼ばれても二重にスキャンしないよう、進行中のビルドをin-flightで共有する。
async function ensureAnalysisCache(): Promise<RaceAggregateEntry[]> {
  if (sharedEntries) return sharedEntries
  if (buildPromise) return buildPromise

  buildPromise = (async () => {
    let entries: RaceAggregateEntry[] = []
    try {
      entries = JSON.parse(await fs.readFile(ANALYSIS_CACHE_PATH, 'utf-8'))
    } catch {
      entries = []
    }
    const covered = new Set(entries.map((e) => e.period))

    const dates = await listAvailableKyiDates()
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const confirmedDates = dates.filter((d) => d < today) // 未確定の未来レースは集計対象外
    const missingDates = confirmedDates.filter((d) => !covered.has(isoDateOf(d)))

    if (missingDates.length > 0) {
      console.log(`[jrdb-cache] ${missingDates.length}日分を新たに集計します...`)
      const newEntries = await scanDatesAggregated(missingDates)
      entries = [...entries, ...newEntries]
      try {
        await fs.writeFile(ANALYSIS_CACHE_PATH, JSON.stringify(entries))
      } catch (err) {
        console.error('[jrdb-cache] 永続化に失敗しました(次回起動時に再計算されます):', err)
      }
    }

    sharedEntries = entries
    return entries
  })()

  try {
    return await buildPromise
  } finally {
    buildPromise = null
  }
}

// アーカイブ全体(または期間・確信度で絞り込み)を実際に回した場合の券種別的中率・回収率を集計する。
export async function computeJrdbBacktestStats(options?: {
  daysBack?: number
  confidenceFilter?: string[]
}): Promise<JrdbStatsSummary> {
  const cacheKey = `${options?.daysBack ?? 'all'}|${[...(options?.confidenceFilter ?? [])].sort().join(',')}`
  const cached = backtestCache.get(cacheKey)
  if (cached && Date.now() - cached.computedAt < BACKTEST_CACHE_TTL_MS) {
    return cached.result
  }

  let entries = await ensureAnalysisCache()
  if (options?.daysBack) {
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - options.daysBack)
    const cutoffIso = isoDateOf(cutoff)
    entries = entries.filter((e) => e.period >= cutoffIso)
  }
  if (options?.confidenceFilter && options.confidenceFilter.length > 0) {
    entries = entries.filter((e) => options.confidenceFilter!.includes(e.confidence))
  }

  const agg = new Map<string, RaceTypeAgg>()
  for (const entry of entries) {
    for (const type of JRDB_BET_TYPE_ORDER) {
      const t = entry.byType[type]
      if (!t) continue
      const cur = agg.get(type) ?? emptyAgg()
      cur.attempts += t.attempts
      cur.hits += t.hits
      cur.stake += t.stake
      cur.payout += t.payout
      agg.set(type, cur)
    }
  }

  const byType: JrdbBetTypeStats[] = JRDB_BET_TYPE_ORDER.filter((t) => agg.has(t)).map((betType) => {
    const v = agg.get(betType)!
    return {
      betType,
      attempts: v.attempts,
      hits: v.hits,
      hitRate: v.attempts > 0 ? Math.round((v.hits / v.attempts) * 1000) / 10 : 0,
      totalStakeYen: v.stake,
      totalPayout: v.payout,
      returnRate: v.stake > 0 ? Math.round((v.payout / v.stake) * 1000) / 10 : 0,
    }
  })

  const totalStakeYen = byType.reduce((s, t) => s + t.totalStakeYen, 0)
  const totalPayout = byType.reduce((s, t) => s + t.totalPayout, 0)

  const result: JrdbStatsSummary = {
    raceCount: entries.length,
    totalStakeYen,
    totalPayout,
    netYen: totalPayout - totalStakeYen,
    returnRate: totalStakeYen > 0 ? Math.round((totalPayout / totalStakeYen) * 1000) / 10 : 0,
    byType,
  }
  backtestCache.set(cacheKey, { computedAt: Date.now(), result })
  return result
}

export type JrdbStatsPeriodPoint = {
  period: string // 'day' なら YYYY-MM-DD、'month' なら YYYY-MM
  attempts: number
  hits: number
  totalStakeYen: number
  totalPayout: number
  returnRate: number // 当該期間単体の金額回収率(%)
  cumulativeReturnRate: number // 集計開始からの累積金額回収率(%)
}

// ダッシュボードの回収率推移グラフ用。期間・確信度で絞り込んだ上で日別/月別に集計し、累積回収率も算出する。
export async function computeJrdbBacktestTimeseries(
  granularity: 'day' | 'month',
  options?: { daysBack?: number; confidenceFilter?: string[] },
): Promise<JrdbStatsPeriodPoint[]> {
  const cacheKey = `${granularity}|${options?.daysBack ?? 'all'}|${[...(options?.confidenceFilter ?? [])].sort().join(',')}`
  const cached = timeseriesCache.get(cacheKey)
  if (cached && Date.now() - cached.computedAt < BACKTEST_CACHE_TTL_MS) {
    return cached.result
  }

  let entries = await ensureAnalysisCache()
  if (options?.daysBack) {
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - options.daysBack)
    const cutoffIso = isoDateOf(cutoff)
    entries = entries.filter((e) => e.period >= cutoffIso)
  }
  if (options?.confidenceFilter && options.confidenceFilter.length > 0) {
    entries = entries.filter((e) => options.confidenceFilter!.includes(e.confidence))
  }

  const bucket = new Map<string, RaceTypeAgg>()
  for (const entry of entries) {
    const key = granularity === 'month' ? entry.period.slice(0, 7) : entry.period
    const cur = bucket.get(key) ?? emptyAgg()
    for (const type of JRDB_BET_TYPE_ORDER) {
      const t = entry.byType[type]
      if (!t) continue
      cur.attempts += t.attempts
      cur.hits += t.hits
      cur.stake += t.stake
      cur.payout += t.payout
    }
    bucket.set(key, cur)
  }

  const sortedPeriods = [...bucket.keys()].sort()
  let cumStake = 0
  let cumPayout = 0
  const result: JrdbStatsPeriodPoint[] = sortedPeriods.map((period) => {
    const v = bucket.get(period)!
    cumStake += v.stake
    cumPayout += v.payout
    return {
      period,
      attempts: v.attempts,
      hits: v.hits,
      totalStakeYen: v.stake,
      totalPayout: v.payout,
      returnRate: v.stake > 0 ? Math.round((v.payout / v.stake) * 1000) / 10 : 0,
      cumulativeReturnRate: cumStake > 0 ? Math.round((cumPayout / cumStake) * 1000) / 10 : 0,
    }
  })

  timeseriesCache.set(cacheKey, { computedAt: Date.now(), result })
  return result
}

// 予測履歴(History)ページ用: 期間・確信度で絞り込んだ検索可能なレース一覧。デフォルトは直近3週間。
export async function searchJrdbRaces(options?: {
  daysBack?: number
  confidenceFilter?: string[]
  venueName?: string
}): Promise<JrdbRaceRecord[]> {
  const daysBack = options?.daysBack ?? 21
  let records = await scanJrdbRaceRange(daysBack)
  if (options?.confidenceFilter && options.confidenceFilter.length > 0) {
    records = records.filter((r) => options.confidenceFilter!.includes(r.confidence))
  }
  if (options?.venueName) {
    records = records.filter((r) => r.venueName === options.venueName)
  }
  return records
}

// 新しいデータをダウンロードした後など、集計結果が古くなった際にキャッシュを破棄する。
// ディスク上の永続キャッシュ(jrdb-analysis-cache.json)自体は消さない — 次回ensureAnalysisCache()が
// 呼ばれた時に新規追加された日付だけを差分計算するので、既存分を再計算する必要はない。
export function invalidateJrdbCaches(): void {
  backtestCache.clear()
  timeseriesCache.clear()
  sharedEntries = null
}

// ダッシュボードでよく使う(フィルタ無しの)組み合わせをあらかじめ計算してキャッシュに温めておく。
// サーバー起動時・同期完了後に呼ぶ想定。ensureAnalysisCache()を先に済ませてから各集計を行うことで、
// 重い全アーカイブスキャン(ファイル読込+買い目計算)が1回だけで済むようにしている
// (以前は3つの集計がそれぞれ独立にフルスキャンし、3重に実行されてJSヒープ不足でクラッシュしていた)。
export async function warmJrdbCaches(): Promise<void> {
  await ensureAnalysisCache()
  await Promise.all([
    computeJrdbBacktestStats(),
    computeJrdbBacktestTimeseries('day'),
    computeJrdbBacktestTimeseries('month'),
  ])
}
