import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import SharePage from './SharePage.jsx'
import './styles.css'

const shareMatch = window.location.pathname.match(/^\/share\/([\w-]+)/)

ReactDOM.createRoot(document.getElementById('root')).render(
  shareMatch ? <SharePage token={shareMatch[1]} /> : <App />
)
