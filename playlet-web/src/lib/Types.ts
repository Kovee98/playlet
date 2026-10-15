export const ScreenNames = ["search", "home", "subscriptions", "bookmarks", "settings", "info", "remote"] as const;

export enum ProfileAuthState {
    Authenticated = "Authenticated",
    NeedsReauth = "NeedsReauth",
}

export type AppState = {
    screen: typeof ScreenNames[number]
}

export type PlayletState = {
    app?: any,
    device?: any,
    invidious?: any,
    preferences?: any,
    profiles?: any,
}
