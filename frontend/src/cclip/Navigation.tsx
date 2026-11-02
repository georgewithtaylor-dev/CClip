import { createContext, useContext } from 'react'
import { useNavigate } from 'react-router-dom'

export const WorkbenchNavigation = createContext<((path: string) => void) | null>(null)

/** Original Studio controls can open their tools inside the CClip workbench. */
export function useCClipNavigate() {
  const navigate = useNavigate()
  return useContext(WorkbenchNavigation) || navigate
}
