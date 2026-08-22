import { BrowserRouter, Routes, Route } from 'react-router-dom'
import AppNavbar from './components/AppNavbar'
import Dashboard from './components/Dashboard'
import Prediction from './components/Prediction'

function App() {
  return (
    <BrowserRouter>
      <AppNavbar />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/predict" element={<Prediction />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
