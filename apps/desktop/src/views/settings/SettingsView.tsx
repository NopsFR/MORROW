import { Icon } from "@morrow/ui";
import { SETTINGS_META, SETTINGS_PAGES, navigate, useSettingsPage, type SettingsPage } from "../../shell/navigation";
import { CapabilitiesPage } from "./CapabilitiesPage";
import { ModelsPage } from "./ModelsPage";
import { PermissionsPage } from "./PermissionsPage";
import { SystemPage } from "./SystemPage";
import "./settings.css";

const PAGES: Record<SettingsPage, () => React.JSX.Element> = {
  MODELS: ModelsPage,
  PERMISSIONS: PermissionsPage,
  CAPABILITIES: CapabilitiesPage,
  SYSTEM: SystemPage,
};

/**
 * What MORROW works with. Only pages backed by real runtime state exist here: there is
 * no account, appearance or device page because MORROW has no such settings yet.
 */
export function SettingsView() {
  const page = useSettingsPage();
  const Page = PAGES[page];
  return (
    <div className="settings">
      <nav className="settings__nav m-panel m-panel--glass" aria-label="Settings">
        <span className="m-label m-tone-muted settings__heading">Settings</span>
        <ul>
          {SETTINGS_PAGES.map((p) => {
            const meta = SETTINGS_META[p];
            return (
              <li key={p}>
                <button
                  type="button"
                  className="settings__tab"
                  aria-current={p === page ? "page" : undefined}
                  onClick={() => navigate("SETTINGS", p)}
                >
                  <Icon name={meta.icon} />
                  <span className="settings__tab-text">
                    <span className="settings__tab-name">{meta.name}</span>
                    <span className="settings__tab-summary">{meta.summary}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="settings__page">
        <Page key={page} />
      </div>
    </div>
  );
}
