import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AppProvider } from './store/app'
import { ReadingPrefsProvider } from './lib/prefs'
import { ThemeProvider } from './lib/theme'
import { installRendererDiagnostics } from './lib/diagnostics'

// 使用 data router 以支持编辑页的未保存修改路由拦截（useBlocker）
const router = createBrowserRouter([{ path: '*', element: <App /> }])

// 渲染进程诊断上报（错误 / 未处理拒绝 / 长任务），在渲染前安装
installRendererDiagnostics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ReadingPrefsProvider>
        <AppProvider>
          <RouterProvider router={router} />
        </AppProvider>
      </ReadingPrefsProvider>
    </ThemeProvider>
  </StrictMode>,
)
