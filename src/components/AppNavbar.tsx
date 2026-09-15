import { NavLink } from 'react-router-dom'

export const NAV_ITEMS = [
  { to: '/', label: 'ダッシュボード', icon: 'bi-speedometer2' },
  { to: '/jrdb', label: 'JRDB検索', icon: 'bi-database-fill' },
  { to: '/predict', label: 'netkeiba情報取得', icon: 'bi-search' },
  { to: '/history', label: '予想履歴', icon: 'bi-clock-history' },
]

function AppNavbar() {
  return (
    <nav className="navbar navbar-dark app-navbar sticky-top shadow-sm">
      <div className="container">
        <NavLink className="navbar-brand fw-semibold app-brand mb-0" to="/">
          <i className="bi bi-compass-fill me-2" />
          回収の羅針盤
        </NavLink>
        <ul className="navbar-nav flex-row gap-1 d-none d-md-flex">
          {NAV_ITEMS.map((item) => (
            <li className="nav-item" key={item.to}>
              <NavLink
                className={({ isActive }) => `nav-link px-3 ${isActive ? 'active' : ''}`}
                to={item.to}
                end={item.to === '/'}
              >
                <i className={`bi ${item.icon} me-1`} />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  )
}

export default AppNavbar
