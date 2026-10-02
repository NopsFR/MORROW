import { Count, Icon } from "@morrow/ui";
import { useMorrow } from "../runtime/store";
import { Identity } from "./Identity";
import { SECTIONS, SECTION_META, navigate, useSection, type Section } from "./navigation";

/**
 * Where you can go. Work sections at the top; Settings — what MORROW works with — at
 * the bottom. The only badge is real: decisions waiting on you, shown on the workspace
 * where they are answered.
 */
export function NavRail() {
  const active = useSection();
  const pending = useMorrow((s) => s.pendingPermissions.length);
  const item = (section: Section) => {
    const meta = SECTION_META[section];
    return (
      <li key={section}>
        <button
          type="button"
          className="rail__item"
          aria-current={section === active ? "page" : undefined}
          onClick={() => navigate(section)}
          aria-label={section === "WORKSPACE" && pending > 0 ? `${meta.name}, ${pending} waiting for you` : meta.name}
        >
          <span className="rail__icon" aria-hidden="true">
            <Icon name={meta.icon} size="lg" />
            {section === "WORKSPACE" ? (
              <span className="rail__badge">
                <Count value={pending} tone="accent" />
              </span>
            ) : null}
          </span>
          <span className="rail__name" aria-hidden="true">
            {meta.name}
          </span>
        </button>
      </li>
    );
  };
  return (
    <nav className="rail m-panel m-panel--glass" aria-label="MORROW">
      <Identity />
      <ul className="rail__list">{SECTIONS.filter((s) => SECTION_META[s].group === "work").map(item)}</ul>
      <ul className="rail__list rail__list--end">{SECTIONS.filter((s) => SECTION_META[s].group === "system").map(item)}</ul>
    </nav>
  );
}
