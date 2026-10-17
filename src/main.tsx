import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AppProvider } from './store/app'
import { ReadingPrefsProvider } from './lib/prefs'

// 使用 data router 以支持编辑页的未保存修改路由拦截（useBlocker）
const router = createBrowserRouter([{ path: '*', element: <App /> }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReadingPrefsProvider>
      <AppProvider>
        <RouterProvider router={router} />
      </AppProvider>
    </ReadingPrefsProvider>
  </StrictMode>,
)
