import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AppearanceTab } from "./AppearanceTab";

const SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "publishing", label: "Publishing" },
  { id: "github", label: "GitHub" },
  { id: "about", label: "About" },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

interface SettingsHubProps {
  /** Called when the user leaves the hub via the Back button. */
  onBack: () => void;
}

/**
 * Settings hub (UI Task 1.4). A horizontal tablist covers General,
 * Appearance, Publishing, GitHub, and About. Appearance is the functional
 * tab; the other four are clearly identified structural placeholders until
 * later tasks fill them in. The full responsive app shell is Task 2.1.
 */
export function SettingsHub({ onBack }: SettingsHubProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("appearance");
  const [focusIndex, setFocusIndex] = useState(1);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function selectTab(index: number): void {
    setActiveTab(SETTINGS_TABS[index].id);
    setFocusIndex(index);
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % SETTINGS_TABS.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = SETTINGS_TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectTab(next);
  }

  return (
    <section className="settings" id="settings-hub" aria-label="Settings">
      <header className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <button type="button" className="settings-back" onClick={onBack}>
          Back
        </button>
      </header>

      <nav className="settings-nav">
        <div
          className="settings-tablist"
          role="tablist"
          aria-label="Settings sections"
        >
          {SETTINGS_TABS.map((tab, index) => (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`settings-tab-${tab.id}`}
              className="settings-tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              tabIndex={index === focusIndex ? 0 : -1}
              onClick={() => selectTab(index)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {SETTINGS_TABS.map((tab) => (
        <section
          key={tab.id}
          role="tabpanel"
          id={`settings-panel-${tab.id}`}
          aria-labelledby={`settings-tab-${tab.id}`}
          className="settings-panel"
          hidden={tab.id !== activeTab}
        >
          {tab.id === "appearance" ? (
            <AppearanceTab />
          ) : (
            <div className="settings-placeholder">
              <h2>{tab.label}</h2>
              <p>
                {tab.label} settings will arrive in a later task. This panel
                is a structural placeholder and has no controls yet.
              </p>
            </div>
          )}
        </section>
      ))}
    </section>
  );
}
