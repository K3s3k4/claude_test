type Stat = {
  label: string
  value: string
  change: string
  trend: 'up' | 'down'
  icon: string
}

const STATS: Stat[] = [
  { label: '総ユーザー数', value: '12,483', change: '+8.2%', trend: 'up', icon: 'bi-people-fill' },
  { label: '売上', value: '¥2,340,000', change: '+12.5%', trend: 'up', icon: 'bi-graph-up-arrow' },
  { label: '注文数', value: '1,024', change: '-3.1%', trend: 'down', icon: 'bi-bag-check-fill' },
  { label: 'コンバージョン率', value: '3.8%', change: '+0.4%', trend: 'up', icon: 'bi-bullseye' },
]

const RECENT_ACTIVITY = [
  { name: '佐藤 花子', action: '新規登録', time: '2分前' },
  { name: '田中 太郎', action: '注文を完了', time: '18分前' },
  { name: '鈴木 一郎', action: 'プランをアップグレード', time: '1時間前' },
  { name: '高橋 陽子', action: 'サポートに問い合わせ', time: '3時間前' },
]

function Dashboard() {
  return (
    <div className="container py-4">
      <div className="mb-4">
        <h1 className="h3 fw-bold mb-1">ダッシュボード</h1>
        <p className="text-muted mb-0">ようこそ。サイトの概況はこちらです。</p>
      </div>

      <div className="row g-3 mb-4">
        {STATS.map((stat) => (
          <div className="col-6 col-lg-3" key={stat.label}>
            <div className="card h-100 border-0 shadow-sm">
              <div className="card-body">
                <div className="d-flex justify-content-between align-items-start mb-2">
                  <span className="text-muted small">{stat.label}</span>
                  <span className="rounded-circle bg-primary bg-opacity-10 text-primary d-inline-flex align-items-center justify-content-center" style={{ width: 36, height: 36 }}>
                    <i className={`bi ${stat.icon}`} />
                  </span>
                </div>
                <div className="fs-4 fw-bold">{stat.value}</div>
                <div className={`small ${stat.trend === 'up' ? 'text-success' : 'text-danger'}`}>
                  <i className={`bi ${stat.trend === 'up' ? 'bi-arrow-up-short' : 'bi-arrow-down-short'}`} />
                  {stat.change}
                  <span className="text-muted"> 先月比</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="row g-3">
        <div className="col-lg-8">
          <div className="card border-0 shadow-sm h-100">
            <div className="card-body">
              <h2 className="h6 fw-bold mb-3">概要</h2>
              <div className="d-flex align-items-center justify-content-center text-muted bg-light rounded" style={{ height: 260 }}>
                グラフ表示エリア（後で実装）
              </div>
            </div>
          </div>
        </div>
        <div className="col-lg-4">
          <div className="card border-0 shadow-sm h-100">
            <div className="card-body">
              <h2 className="h6 fw-bold mb-3">最近のアクティビティ</h2>
              <ul className="list-group list-group-flush">
                {RECENT_ACTIVITY.map((item) => (
                  <li className="list-group-item px-0 d-flex justify-content-between align-items-center" key={item.name + item.time}>
                    <div>
                      <div className="fw-semibold small">{item.name}</div>
                      <div className="text-muted small">{item.action}</div>
                    </div>
                    <span className="text-muted small">{item.time}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
