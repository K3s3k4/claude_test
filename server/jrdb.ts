import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import axios from 'axios'

const JRDB_BASE = 'https://jrdb.com/member/data'
const DATA_DIR = path.join(import.meta.dirname, '..', 'data', 'jrdb')

export class JrdbAuthError extends Error {
  constructor() {
    super('JRDBの認証に失敗しました。.envのJRDB_USER/JRDB_PASSWORDを確認してください。')
    this.name = 'JrdbAuthError'
  }
}

export function jitteredSleep(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Tyb(直前情報)は発走約15分前のオッズ・馬体重・当日馬場状態を持つ。
// KYIの基準オッズは前日時点の値なので、市場との乖離を正確に測るにはTybが必要。
// Skb(成績拡張)はSEDと同じ結果確定後の配信。パドック・脚元コメントや特記/馬具コードを含むが、
// レースコメント(レース後の講評)も混在するため、予想への利用可否は項目ごとに判断が必要。
export type JrdbFileType = 'Kyi' | 'Sed' | 'Hjc' | 'Ukc' | 'Tyb' | 'Skb'

export function toYymmdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

// lhasaコマンド(LZH解凍)で指定ディレクトリに展開する。x=展開 f=上書き許可 q2=静音。
function extractLzh(lzhPath: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // lhasaはモード+オプションを1トークンに連結する必要がある(例: xfq2w=dir)。分けると解釈されない。
    const proc = spawn('lhasa', [`xfq2w=${outDir}`, lzhPath])
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', (err) => reject(new Error(`lhasaの起動に失敗しました(インストールされていますか?): ${err.message}`)))
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`lhasa解凍に失敗しました(code ${code}): ${stderr}`))))
  })
}

// 1日・1種別ぶんをダウンロード&解凍し、抽出したファイルパスの一覧を返す。
// その日にデータが無い(404)場合は null を返す。既に展開済みなら再ダウンロードせずスキップする。
export async function downloadJrdbFile(type: JrdbFileType, date: Date): Promise<string[] | null> {
  const user = process.env.JRDB_USER
  const password = process.env.JRDB_PASSWORD
  if (!user || !password) throw new Error('JRDB_USER/JRDB_PASSWORDが設定されていません(.envを確認してください)')

  const dateStr = toYymmdd(date)
  const prefix = type.toUpperCase()
  const outDir = path.join(DATA_DIR, type)
  const expectedFile = path.join(outDir, `${prefix}${dateStr}.txt`)

  try {
    await fs.access(expectedFile)
    return [expectedFile] // 既に取得済み
  } catch {
    // 未取得なので続行
  }

  const url = `${JRDB_BASE}/${type}/${prefix}${dateStr}.lzh`
  let res
  try {
    res = await axios.get<ArrayBuffer>(url, {
      auth: { username: user, password },
      responseType: 'arraybuffer',
      timeout: 20000,
      validateStatus: (s) => s === 200 || s === 404,
    })
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401) throw new JrdbAuthError()
    throw err
  }
  if (res.status === 401) throw new JrdbAuthError()
  if (res.status === 404) return null

  await fs.mkdir(outDir, { recursive: true })
  const tmpDir = await fs.mkdtemp(path.join(DATA_DIR, '.tmp-'))
  const lzhPath = path.join(tmpDir, `${prefix}${dateStr}.lzh`)
  try {
    await fs.writeFile(lzhPath, Buffer.from(res.data))
    await extractLzh(lzhPath, outDir)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }

  const entries = await fs.readdir(outDir)
  return entries.filter((f) => f.includes(dateStr)).map((f) => path.join(outDir, f))
}

export type JrdbSyncProgress = {
  status: 'running' | 'done' | 'error'
  totalChecks: number
  checked: number
  downloaded: number
  skippedNoData: number
  failed: number
  error?: string
}

// 直近の未取得分を埋める同期。過去(結果反映漏れがないか)と未来(公開され次第すぐ取り込む)の両方を見る。
// 既存ファイルはdownloadJrdbFile側でスキップされるため、範囲を広めに取っても無駄なダウンロードは発生しない。
const SYNC_PAST_DAYS = 14
const SYNC_FUTURE_DAYS = 10
const SYNC_TYPES: JrdbFileType[] = ['Kyi', 'Sed', 'Hjc']

export async function syncJrdbData(onProgress?: (p: JrdbSyncProgress) => void): Promise<JrdbSyncProgress> {
  const today = new Date()
  const offsets: number[] = []
  for (let o = -SYNC_FUTURE_DAYS; o <= SYNC_PAST_DAYS; o++) offsets.push(o) // 負=未来, 正=過去

  const progress: JrdbSyncProgress = {
    status: 'running',
    totalChecks: offsets.length * SYNC_TYPES.length,
    checked: 0,
    downloaded: 0,
    skippedNoData: 0,
    failed: 0,
  }
  onProgress?.(progress)

  for (const offset of offsets) {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    for (const type of SYNC_TYPES) {
      try {
        const files = await downloadJrdbFile(type, date)
        if (files) progress.downloaded++
        else progress.skippedNoData++
      } catch (err) {
        if (err instanceof JrdbAuthError) {
          progress.status = 'error'
          progress.error = err.message
          onProgress?.(progress)
          return progress
        }
        progress.failed++
      }
      progress.checked++
      onProgress?.(progress)
      await jitteredSleep(400, 900)
    }
  }

  progress.status = 'done'
  onProgress?.(progress)
  return progress
}
