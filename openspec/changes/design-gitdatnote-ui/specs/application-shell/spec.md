# Application shell — Delta specification

## ADDED Requirements

### Requirement: Branded application shell
The application MUST present a branded shell with a primary sidebar on desktop, a collapsible icon rail plus drawer on tablet, and a top bar plus full-height drawer on mobile. The shell MUST NOT include browser chrome, OS title bars, minimize/maximize controls, or decorative desktop window frames.

#### Scenario: Desktop shell
- **GIVEN** a viewport of at least 1024px and an active session
- **WHEN** the user loads the app
- **THEN** the 248px sidebar is visible with brand, repository selector, nav, and account area
- **AND** all controls are keyboard reachable in a logical focus order

#### Scenario: Sidebar contents
- **GIVEN** the desktop shell
- **WHEN** the sidebar renders
- **THEN** it shows a brand block (pen-nib logo + "GitDatNote" wordmark), the site/repository selector, primary nav (Articles, Drafts, Published — counter badges), secondary nav (Sites, Settings, Help), and a bottom-anchored user profile (avatar + login name)

#### Scenario: Mobile shell
- **GIVEN** a viewport below 640px
- **WHEN** the user taps the menu button
- **THEN** the sidebar opens as a full-height drawer
- **AND** Escape or the close control closes it and returns focus to the trigger

### Requirement: Repository selector
The shell MUST show the currently selected repository in every screen's header area and allow switching between repositories reported by `GET /api/repositories`, displaying `owner/name` and a read-only indicator when `canWrite` is false.

#### Scenario: Read-only repository indicator
- **GIVEN** a repository with `canWrite: false`
- **WHEN** it is selected
- **THEN** the selector and the active screen show a visible read-only indicator
- **AND** all write affordances (New Article, Save, Publish) are disabled with a textual reason

#### Scenario: Not connected
- **GIVEN** `GET /api/session` returns 401
- **WHEN** the shell renders
- **THEN** a prominent "Connect GitHub" action is shown
- **AND** no dashboard, editor, or repository content is reachable

### Requirement: Navigation states
Nav links MUST have default, hover, active (accent indicator), and focus states; the active item MUST be identifiable without color alone.

#### Scenario: Active nav state
- **GIVEN** the Articles screen is active
- **WHEN** the user tabs through the nav
- **THEN** the active item shows an accent indicator and an accessible current-page state
- **AND** focus is visible in both light and dark appearance modes
