# Appearance theming — Delta specification

## ADDED Requirements

### Requirement: Appearance modes
The application MUST support three appearance modes — Light, Dark, and System (follows `prefers-color-scheme`) — selectable independently of the accent palette.

#### Scenario: System mode tracks OS
- **GIVEN** the user selected System appearance
- **WHEN** the operating system switches to dark
- **THEN** the app re-applies dark tokens live without a reload

#### Scenario: Explicit mode ignores OS
- **GIVEN** the user selected Light appearance
- **WHEN** the operating system switches to dark
- **THEN** the app remains Light

### Requirement: Accent palettes
The application MUST offer the six approved accent palettes (Lavender default, Sage, Ocean, Slate, Clay, Teal) with their exact approved `--accent` and soft-background values. Accent and appearance mode MUST be independent settings.

#### Scenario: Palette values exact
- **GIVEN** the token module
- **WHEN** each palette is inspected
- **THEN** `--accent` and soft background match the approved table exactly (e.g., Lavender `#8271C8` / `#F2EFFB`)

#### Scenario: Accent influences UI
- **GIVEN** a selected palette
- **WHEN** the app renders
- **THEN** primary actions, selected navigation, active controls, and focus indicators use that accent
- **AND** the editor writing surface remains predominantly neutral

### Requirement: Contrast-safe accent foregrounds
Small text on accent fills MUST use each palette's `--accent-strong` darkened variant (measured ≥ 4.5:1 with white). The raw accent MUST be reserved for large/bold text, icons, focus rings, and decorative accents.

#### Scenario: Button label contrast
- **GIVEN** the Clay palette (raw accent `#B68774`)
- **WHEN** a primary button renders with a normal-size label
- **THEN** the fill is the `--accent-strong` variant
- **AND** the label contrast is at least 4.5:1

### Requirement: Appearance settings screen
The appearance controls MUST live in an Appearance tab within a Settings hub that retains the global sidebar. The tab MUST present a theme picker (Light/Dark/System) and the six accent swatches, indicate the current selections clearly (text plus outline, not outline only), apply changes immediately to the whole app, and be fully keyboard operable.

#### Scenario: Immediate preview
- **GIVEN** the Appearance settings screen
- **WHEN** the user selects the Ocean palette
- **THEN** the entire app, including the settings screen, re-themes immediately
- **AND** the Ocean tile shows a "Current" indicator

#### Scenario: Layout
- **GIVEN** the Appearance tab
- **WHEN** it renders
- **THEN** a horizontal settings nav (General, Appearance, Publishing, GitHub, About) is shown
- **AND** the theme picker uses line-icon cards with a selection ring on the current mode, and the accents render as circular swatches with a selection ring + label on the active one

#### Scenario: Keyboard selection
- **GIVEN** the Accent section focused
- **WHEN** the user uses arrow keys and Enter
- **THEN** palettes are navigated and selected by keyboard
- **AND** a visible focus ring appears on the active tile

### Requirement: Persistence with graceful fallback
Preferences MUST persist in browser-local storage under a versioned key. When storage is unavailable (private mode, quota), the app MUST fall back to in-memory defaults without throwing or repeated write attempts.

#### Scenario: Persistence round-trip
- **GIVEN** the user selects Dark + Sage
- **WHEN** the app reloads
- **THEN** Dark and Sage are restored

#### Scenario: Storage unavailable
- **GIVEN** localStorage is disabled
- **WHEN** the user selects a palette
- **THEN** the change applies for the session
- **AND** no error is thrown and no exception surfaces to the user

### Requirement: No new persistence backend
Appearance preferences MUST NOT require account-settings APIs or new database tables. Browser-local persistence is sufficient for the initial version.

#### Scenario: No backend dependency
- **GIVEN** the app with no backend session
- **WHEN** the user changes appearance
- **THEN** the change is stored locally only and the UI updates
