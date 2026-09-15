import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AppNavbar from './components/AppNavbar'
import MobileBottomNav from './components/MobileBottomNav'
import Dashboard from './components/Dashboard'
import Prediction from './components/Prediction'
import History from './components/History'
import JrdbSearch from './components/JrdbSearch'

function App() {
  return (
    <BrowserRouter>
      <AppNavbar />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/predict" element={<Prediction />} />
        <Route path="/history" element={<History />} />
        <Route path="/jrdb" element={<JrdbSearch />} />
      </Routes>
      <MobileBottomNav />
    </BrowserRouter>
  )
}

export default App
