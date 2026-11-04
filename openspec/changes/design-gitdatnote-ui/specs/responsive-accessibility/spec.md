# Responsive design and accessibility — Delta specification

## ADDED Requirements

### Requirement: Responsive layouts
All screens MUST adapt to desktop (≥1024px), tablet (640–1023px), and mobile (<640px) without horizontal overflow at any supported width (minimum test width 320px).

#### Scenario: No horizontal overflow
- **GIVEN** each screen (dashboard, editor, onboarding, appearance)
- **WHEN** rendered at 320, 768, 1024, and 1280px
- **THEN** no element overflows horizontally
- **AND** essential information is not truncated away

#### Scenario: Editor on mobile
- **GIVEN** the editor on a viewport below 640px
- **WHEN** it renders
- **THEN** the writing surface is full-screen primary and the metadata sidebar opens as an overlay
- **AND** the top bar wraps without losing Save or back

### Requirement: Full keyboard accessibility
Every action MUST be reachable and operable by keyboard alone. This includes the article list, action menus, dialogs, filters, tabs, forms, and theme controls. Semantic, naturally-focusable controls (real links, buttons, list rows) are preferred over roving-tabindex complexity.

#### Scenario: Keyboard-only session
- **GIVEN** no pointer
- **WHEN** a user completes: load, filter, search, open an article, edit, save, publish, change theme
- **THEN** every step is possible using only the keyboard
- **AND** focus is never trapped invisibly

### Requirement: Visible focus states
A visible focus indicator MUST appear on every focusable control in both light and dark appearance modes, using a 2px accent ring with a 2px offset that meets ≥3:1 contrast against adjacent colors.

#### Scenario: Focus visible in dark mode
- **GIVEN** Dark appearance
- **WHEN** the user tabs to a control
- **THEN** the focus ring is clearly visible
- **AND** it is not border-only

### Requirement: Accessible input labels and errors
Every input MUST have an accessible label (visible or `aria-label`). Error messages MUST be specific, visible, actionable, and linked to their field via `aria-describedby`.

#### Scenario: Labeled error
- **GIVEN** an invalid content-root input
- **WHEN** the user submits
- **THEN** an error message appears, is programmatically associated with the field
- **AND** a screen reader announces the error on the field

### Requirement: Live status announcements
Status changes (save in progress, save success, save failure, list loading, theme change, conflict) MUST be announced via `aria-live` regions (polite; assertive for errors).

#### Scenario: Save announced
- **GIVEN** a screen-reader user
- **WHEN** a save succeeds
- **THEN** a polite live-region announcement confirms the save
- **AND** no silent state change occurs

### Requirement: Screen-reader compatibility
The UI MUST use semantic landmarks (banner, nav, main, complementary), list semantics for the article list, dialog semantics with focus trap and focus restore, and no icon-only affordances without text alternatives.

#### Scenario: Landmarks present
- **GIVEN** the app rendered
- **WHEN** a screen reader queries landmarks
- **THEN** banner, navigation, main, and complementary regions are present and labeled

#### Scenario: Icon button labeled
- **GIVEN** an icon-only action button
- **WHEN** it is focused
- **THEN** an accessible name is available via `aria-label`

### Requirement: Text contrast
Body text MUST meet ≥4.5:1 and large text ≥3:1 in every accent palette × appearance-mode combination. The token set MUST be constructed and asserted to pass.

#### Scenario: Contrast assertion
- **GIVEN** all six palettes in light and dark modes
- **WHEN** contrast is measured for body text on surfaces and primary-button labels on `--accent-strong`
- **THEN** every pair meets the required ratio

### Requirement: Reduced motion
When `prefers-reduced-motion: reduce` is set, the app MUST disable or minimize animations, skeleton motion, and auto-scroll.

#### Scenario: Reduced motion respected
- **GIVEN** the OS reduced-motion preference is set
- **WHEN** the app loads content
- **THEN** skeletons render as static placeholders
- **AND** no non-essential motion occurs

### Requirement: Touch and scaling
Touch targets MUST be at least 24px (primary actions at least 44px on mobile). No functionality MUST depend on hover. Zoom to 200% MUST preserve layout and function without horizontal scroll.

#### Scenario: 200% zoom
- **GIVEN** the browser zoom set to 200%
- **WHEN** the dashboard renders
- **THEN** all controls remain reachable and no content is cut off
- **AND** no horizontal scroll appears

### Requirement: No color-alone information
No information MUST be conveyed by color alone. Status badges MUST carry text, and read-only/disabled states MUST carry textual or icon-plus-text indicators.

#### Scenario: Status not color-only
- **GIVEN** a draft and a published article
- **WHEN** their badges render
- **THEN** each badge contains readable text ("Draft"/"Published")
- **AND** the distinction does not rely on hue alone
