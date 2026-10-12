export type SidebarTab = 'search' | 'recent'

/**
 * `recentPage` sits beside `tab` rather than inside a per-tab variant so it
 * survives a trip to the search tab and back.
 */
export interface SidebarState {
  tab: SidebarTab
  recentPage: number
}

export type SidebarEvent =
  { type: 'SELECT_TAB'; tab: SidebarTab } | { type: 'SET_RECENT_PAGE'; page: number }

export const INITIAL_SIDEBAR_STATE: SidebarState = {
  tab: 'search',
  recentPage: 0
}

export function sidebarReducer(state: SidebarState, event: SidebarEvent): SidebarState {
  switch (event.type) {
    case 'SELECT_TAB':
      return { ...state, tab: event.tab }
    case 'SET_RECENT_PAGE':
      return { ...state, recentPage: event.page }
  }
}
