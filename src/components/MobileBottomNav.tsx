import { NavLink } from 'react-router-dom'
import { NAV_ITEMS } from './AppNavbar'

function MobileBottomNav() {
  return (
    <nav className="mobile-bottom-nav d-md-none">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) => `mobile-bottom-nav-item ${isActive ? 'active' : ''}`}
        >
          <i className={`bi ${item.icon}`} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

export default MobileBottomNav
